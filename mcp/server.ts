/**
 * The stdio MCP server.
 *
 * A thin surface over `diagram.ts`: each tool declares its arguments with zod,
 * calls one service function, and answers with JSON text. Keeping the logic in
 * the service is what makes the tools testable without a transport, and what
 * keeps the MCP's answers identical to what the app itself would say.
 *
 * Everything the model reads (tool descriptions, the prompt, the startup
 * instructions) is written for someone who has never seen this app. The one
 * thing they all have to state is the cardinality convention, because "1:N"
 * read the wrong way produces a schema that is subtly backwards.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { parseCompactDiagram } from './compact';
import {
  addAttribute,
  addEntity,
  addIsa,
  addRelationship,
  arrangeSession,
  createDiagram,
  errorMessage,
  getDiagram,
  leaveRoom,
  listDiagramFiles,
  openDiagram,
  openRoom,
  peekSession,
  removeDiagramNode,
  saveDiagram,
  serverStatus,
  shareSession,
  sqlForSession,
  summarizeSession,
  updateDiagram,
  updateNode,
  validateSession,
  WORKSPACE_ROOT,
  type AttributeSpec,
  type CreateSpec,
} from './diagram';

/**
 * Builds a server with every tool registered.
 *
 * A factory rather than a single instance because HTTP needs a fresh transport
 * per request, and a transport belongs to exactly one server. stdio builds one
 * and keeps it.
 */
export function createServer(): McpServer {
  const server = new McpServer(
  { name: 'erd-maker', version: '1.0.0' },
  {
    instructions: [
      '# ERD Maker',
      'Read, author, and export entity-relationship diagrams. They are JSON files under ' + WORKSPACE_ROOT + '.',
      '',
      '## The 90% path',
      'create_diagram { name, text } — pass the whole model as indented lines and you are done:',
      '',
      '  Customer',
      '    customer_id: INT key',
      '    email: TEXT unique',
      '  Order',
      '    order_id: INT key',
      '  Customer 1:N Order as places',
      '  Party isa Customer, Supplier',
      '',
      'An unindented line is an entity; indented lines are its attributes (`name`, `name: TYPE`, plus an optional',
      'kind word: key, unique, multivalued, derived, composite). A line with 1:1/1:N/N:1/N:M is a relationship.',
      '`Parent isa Child, Child` is a specialization. Then call validate_diagram, fix what it reports, and',
      'generate_sql. That is the whole job for most requests.',
      '',
      '## Rules that are easy to get wrong',
      '- "1:N" from A to B means one A relates to many Bs. The label at each end describes the entity at that end.',
      '- A key attribute is the primary key and must be unique. Composite attributes own their parts.',
      '- Positions are optional. Give no coordinates and the app arranges the diagram; give x/y on an entity to pin',
      '  it. Only entities take coordinates — attribute columns, diamonds, and lines are placed for you. Leave room:',
      '  ~500px apart across and ~360px down in Chen, ~360px across in crow\'s-foot. summarize_diagram reports',
      '  positions; arrange_diagram re-lays the whole thing out.',
      '- Refer to a shape by id or by unique name. summarize_diagram returns both.',
      '- For participation constraints or attributes on a relationship, use the structured form',
      '  (entities/relationships/isas) instead of text.',
      '',
      '## One diagram at a time',
      'create_diagram or open_diagram makes a diagram current; add/update/remove tools edit it; every edit is written',
      'back to its file. list_diagrams shows what is saved. Use the add/update/remove tools for follow-ups, not for',
      'building a first draft.',
      '',
      '## Live rooms (optional, only when the person wants to watch)',
      'open_room joins an ERD Maker room as a collaborator: later edits appear in the room\'s open tabs as they',
      'happen, with the AI\'s name, cursor, and selection, and no refresh. Omit the link to start a room, or pass the',
      'share link the person gave you to join theirs. A room that already has content wins; the open diagram only',
      'seeds an empty room. create_share_link returns the live room while one is open, otherwise a snapshot URL.',
      'leave_room signs out with a visible farewell — call it only when the person says they are done or asks you to',
      'leave, not when your turn ends.',
    ].join('\n'),
  },
);

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

const viewSchema = z.enum(['chen', 'crowfoot']);
const attributeKindSchema = z.enum(['simple', 'key', 'unique', 'multivalued', 'derived', 'composite']);
const entityKindSchema = z.enum(['strong', 'weak']);
const cardinalitySchema = z.enum(['1:1', '1:N', 'N:1', 'N:M', 'M:N']);

const attributeSpecSchema: z.ZodType<AttributeSpec> = z.lazy(() => z.object({
  name: z.string().describe('Attribute name, e.g. "customer_id".'),
  kind: attributeKindSchema.optional().describe('Defaults to simple, or composite when the attribute has parts.'),
  dataType: z.string().optional().describe('SQL type such as INT, VARCHAR(120), NUMERIC(10,2), DATE, UUID, BOOLEAN, JSONB, or ENUM(\'new\',\'paid\').'),
  attributes: z.array(attributeSpecSchema).optional().describe('Parts of a composite attribute.'),
}));

const entitySpecSchema = z.object({
  name: z.string().describe('Entity name in the database, e.g. "Customer".'),
  kind: entityKindSchema.optional().describe('strong (default) or weak. A weak entity derives its key from a parent through an identifying relationship.'),
  attributes: z.array(attributeSpecSchema).optional().describe('Attributes placed on the entity at creation.'),
  x: z.number().optional().describe('Left edge in the view being created, in pixels. Give both x and y to place the entity deliberately; omit both to take the first free slot.'),
  y: z.number().optional().describe('Top edge in the view being created, in pixels.'),
});

const participationSchema = z.object({
  min: z.number().int().min(0).describe('0 means the entity may take part zero times.'),
  max: z.union([z.number().int().min(1), z.literal('N')]).describe('Biggest number of times the entity may take part; N is unbounded.'),
});

const relationshipSpecSchema = z.object({
  name: z.string().describe('Verb phrase, e.g. "places".'),
  kind: entityKindSchema.optional().describe('strong (default) or weak, for an identifying relationship.'),
  from: z.string().describe('Entity name or id at the first end.'),
  to: z.string().describe('Entity name or id at the second end.'),
  cardinality: cardinalitySchema.optional().describe('from:to, each side describing the entity at that end. Defaults to 1:N.'),
  fromParticipation: participationSchema.optional(),
  toParticipation: participationSchema.optional(),
  attributes: z.array(attributeSpecSchema).optional().describe('Attributes of the association itself, e.g. enrolled_at.'),
});

const isaSpecSchema = z.object({
  parent: z.string().describe('Superclass entity name or id.'),
  children: z.array(z.string()).min(1).describe('Subclass entity names or ids.'),
});

server.registerTool('server_status', {
  title: 'Server status',
  description:
    'Report what this server is running: the workspace, whether a diagram is open (and its name, view, file, ' +
    'shape counts, and live room), with no side effects. The tools here only fail when the server is gone or ' +
    'no diagram is open, so call this first to tell a healthy empty session from one whose tools will error.',
  inputSchema: {},
}, async () => json(serverStatus()));

server.registerTool('create_diagram', {
  title: 'Create a diagram',
  description:
    'Build a whole ERD and open it as the current diagram. Two equivalent ways to say the model; use either, not both.\n\n' +
    'FASTEST — pass `text`, a few indented lines:\n' +
    '  Customer\n' +
    '    customer_id: INT key\n' +
    '    email: TEXT unique\n' +
    '  Order\n' +
    '    order_id: INT key\n' +
    '  Customer 1:N Order as places\n' +
    '  Party isa Customer, Supplier\n\n' +
    'Rules for `text`: an unindented line is an entity (add `weak`, or `@ x,y` to place it). Indented lines are its ' +
    'attributes, written `name`, `name: TYPE`, or either plus a kind word — key, unique, multivalued, derived, ' +
    'composite. Indent further to give a composite attribute its parts. A line with a cardinality in it ' +
    '(1:1, 1:N, N:1, N:M) is a relationship `From CARD To`, named with `as places` or defaulting to "From To". ' +
    '`Parent isa Child, Child` declares a specialization. `#` starts a comment. Errors name the line.\n\n' +
    'STRUCTURED — pass `entities`, `relationships`, `isas` instead, when you need participation constraints or ' +
    'composite parts on a relationship.\n\n' +
    'Either way the diagram is validated and saved to diagrams/<slug>.json unless path or save:false says otherwise, ' +
    'and it streams into a live room shape by shape when one is open. Returns the file path, a text outline, ' +
    'validation issues, and a share link. Positions are optional: no coordinates at all means the app arranges the ' +
    'diagram; give every entity x and y to pin it.',
  inputSchema: {
    name: z.string().describe('Diagram name, e.g. "Sales".'),
    text: z.string().optional().describe('The whole model as indented lines — see the description. Alternative to entities.'),
    view: viewSchema.optional().describe('Notation to show: chen (default) or crowfoot.'),
    entities: z.array(entitySpecSchema).optional().describe('Structured form. Every entity with its attributes, keys, and positions.'),
    relationships: z.array(relationshipSpecSchema).optional().describe('Structured form. Every relationship between two entities with its cardinality.'),
    isas: z.array(isaSpecSchema).optional().describe('Structured form. Every specialization of a base by its subclasses.'),
    path: z.string().optional().describe('Workspace-relative .json path. Omit to use diagrams/<name>.json.'),
    overwrite: z.boolean().optional().describe('Replace the file at path if it already exists.'),
    layout: z.boolean().optional().describe('Auto-arrange the whole diagram. Defaults to auto-arrange when no entity has coordinates; otherwise the x and y you give are kept and shapes without coordinates take the first free slot.'),
    save: z.boolean().optional().describe('Set false to keep the diagram only in this session.'),
  },
}, async ({ text, entities, relationships, isas, ...rest }) => {
  if (text && (entities || relationships || isas)) {
    throw new Error('Pass either text or entities/relationships/isas, not both.');
  }
  const model = text ? parseCompactDiagram(text) : null;
  const spec: CreateSpec = {
    ...rest,
    entities: entities ?? model?.entities ?? [],
    relationships: relationships ?? model?.relationships,
    isas: isas ?? model?.isas,
  };
  if (spec.entities.length === 0) {
    throw new Error('A diagram needs at least one entity. Pass text or a non-empty entities array.');
  }
  return json(await createDiagram(spec));
});

server.registerTool('open_diagram', {
  title: 'Open a diagram',
  description:
    'Open a saved diagram file as the current diagram, replacing whatever was open before. ' +
    'Paths are workspace-relative (or absolute inside the workspace). Use list_diagrams to discover files.',
  inputSchema: {
    path: z.string().describe('Workspace-relative path to a .json diagram file.'),
    view: viewSchema.optional().describe('Show this notation after opening.'),
  },
}, async ({ path, view }) => json(await openDiagram(path, view)));

server.registerTool('open_room', {
  title: 'Open a live room',
  description:
    'Join an ERD Maker room as a collaborator. Every later edit streams into the room\'s open tabs as it happens, ' +
    'shown with the AI\'s cursor and selection, and the person watching does not need to refresh. ' +
    'Pass the share link they sent you, a "#room=..." fragment, or a room id; omit link to start a new room. ' +
    'An empty room is seeded from the link\'s snapshot or the open diagram; a room that already has content wins. ' +
    'Returns the room id, a share link, who is watching, whether the room was seeded, and the diagram summary.',
  inputSchema: {
    link: z.string().optional().describe('Share link, "#room=..." fragment, or room id. Omit to start a new room.'),
    baseUrl: z.string().optional().describe('App URL for the returned link, e.g. https://kuy124.github.io/erd-maker/.'),
    seed: z.boolean().optional().describe('Set false to leave an empty room empty instead of copying the open diagram into it.'),
  },
}, async (options) => json(await openRoom(options)));

server.registerTool('leave_room', {
  title: 'Leave a live room',
  description:
    'Sign out of the live room the assistant is editing, after gliding back to the last shape and pausing, ' +
    'so watchers see it finish rather than watch an avatar that stopped moving. The diagram stays open here: ' +
    'later edits keep working, they just no longer stream. Calling open_room again rejoins, and the pointer ' +
    'resumes where it left off. Call this when the person says they are done, or when they ask the assistant ' +
    'to leave. Does nothing if no room is open.',
  inputSchema: {},
}, async () => json(await leaveRoom()));

server.registerTool('save_diagram', {
  title: 'Save the diagram',
  description:
    'Write the open diagram to disk. Without a path it saves to the file it was opened from. ' +
    'With a path it saves there instead; an existing file at a different path is replaced only when overwrite is true.',
  inputSchema: {
    path: z.string().optional().describe('Workspace-relative .json path to save to.'),
    overwrite: z.boolean().optional().describe('Replace the file at path if it already exists.'),
  },
}, async ({ path, overwrite }) => json({ filePath: await saveDiagram(path, overwrite) }));

server.registerTool('get_diagram', {
  title: 'Get the diagram JSON',
  description:
    'Return the complete JSON document of the open diagram, including every coordinate. ' +
    'Use summarize_diagram instead when you only need names, columns, and relationships.',
  inputSchema: {},
}, async () => json(getDiagram()));

server.registerTool('summarize_diagram', {
  title: 'Summarize the diagram',
  description:
    'Describe the open diagram compactly: entities with their attributes and position in the current view, ' +
    'derived table columns and foreign keys, relationships with cardinality and participation, specializations, and validation issues. ' +
    'Returns both structured data and a readable text outline. Use position to see where each entity sits before moving one.',
  inputSchema: {},
}, async () => json(summarizeSession()));

server.registerTool('validate_diagram', {
  title: 'Validate the diagram',
  description:
    'Report the problems ERD Maker warns about: unnamed shapes, missing keys, incomplete relationships, invalid participation, ' +
    'attributes with no owner, and connections that cannot produce a foreign key. Also says whether SQL can be generated.',
  inputSchema: {},
}, async () => json(validateSession()));

server.registerTool('generate_sql', {
  title: 'Generate SQL',
  description:
    'Generate CREATE TABLE DDL from the open diagram, using the same tables and foreign keys the crow\'s-foot view shows. ' +
    'Many-to-many relationships become junction tables, and weak entities inherit their parent key.',
  inputSchema: {
    dialect: z.enum(['standard', 'postgres', 'mysql', 'sqlite']).optional().describe('Affects surrogate key syntax. Defaults to standard.'),
    dropFirst: z.boolean().optional().describe('Emit DROP TABLE IF EXISTS before each CREATE TABLE.'),
  },
}, async ({ dialect, dropFirst }) => json(sqlForSession(dialect, dropFirst)));

server.registerTool('arrange_diagram', {
  title: 'Auto-arrange the diagram',
  description:
    'Run ERD Maker\'s automatic layout on the open diagram. Optionally switch the view first. ' +
    'Manual connector routes are cleared. Positions for the other notation are left alone.',
  inputSchema: {
    view: viewSchema.optional().describe('Switch to this notation, then arrange it.'),
  },
}, async ({ view }) => json(await arrangeSession(view)));

server.registerTool('add_entity', {
  title: 'Add an entity',
  description:
    'Add one entity to the open diagram, optionally with its attributes. Placement defaults to the first free slot; ' +
    'give x and y to choose a position. The new entity\'s id is returned for later calls.',
  inputSchema: {
    name: z.string(),
    kind: entityKindSchema.optional(),
    attributes: z.array(attributeSpecSchema).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  },
}, async (input) => json(await addEntity(input)));

server.registerTool('add_attribute', {
  title: 'Add an attribute',
  description:
    'Attach one attribute to an entity, relationship, specialization, or composite attribute, referenced by id or name. ' +
    'Composite parts go in attributes. The attribute is placed beside its owner, following the column already there.',
  inputSchema: {
    owner: z.string().describe('Owner id or name.'),
    name: z.string(),
    kind: attributeKindSchema.optional(),
    dataType: z.string().optional().describe('SQL type such as INT, VARCHAR(120), DATE, or ENUM(\'a\',\'b\').'),
    attributes: z.array(attributeSpecSchema).optional().describe('Parts, when this is a composite attribute.'),
  },
}, async (input) => json(await addAttribute(input)));

server.registerTool('add_relationship', {
  title: 'Add a relationship',
  description:
    'Connect two existing entities with a relationship. Cardinality is written from:to and each side describes the entity at that end. ' +
    '"1:N" from Customer to Order means one customer places many orders. ' +
    'Give relationship attributes for associations that carry data, such as enrolled_at on a many-to-many.',
  inputSchema: {
    name: z.string().describe('Verb phrase, e.g. "places".'),
    kind: entityKindSchema.optional().describe('strong (default) or weak, for an identifying relationship.'),
    from: z.string().describe('Entity name or id.'),
    to: z.string().describe('Entity name or id.'),
    cardinality: cardinalitySchema.optional().describe('from:to. "1:N" means the entity on the from side connects at most once per to side. One of: 1:1, 1:N, N:1, N:M, M:N.'),
    fromParticipation: participationSchema.optional().describe('How many times the entity at from must take part.'),
    toParticipation: participationSchema.optional().describe('How many times the entity at to must take part.'),
    attributes: z.array(attributeSpecSchema).optional().describe('Attributes of the association itself, e.g. enrolled_at.'),
  },
}, async (input) => json(await addRelationship(input)));

server.registerTool('add_isa', {
  title: 'Add a specialization',
  description:
    'Add a specialization (an is-a) to the open diagram. The base entity becomes the parent; every child is a ' +
    'subclass that inherits its keys and values. If the parent already has a specialization, it is extended with ' +
    'the new children so a base keeps its subclasses in one shape. Refer to the shapes by id or unique name, and ' +
    'return the returned id in later calls with update_node or remove_node.',
  inputSchema: {
    parent: z.string().describe('Id or unique name of the base entity.'),
    children: z.array(z.string()).min(1).describe('Ids or unique names of the subclasses.'),
    name: z.string().optional().describe('Name assigned to the specialization, defaulting to "Specialization".'),
  },
}, async (input) => json(await addIsa(input)));

server.registerTool('update_node', {
  title: 'Update a shape',
  description:
    'Rename or retype a shape, or move an entity to a given point. ' +
    'An entity takes a name, kind, and x/y; a relationship takes a name or kind; an attribute takes a name, kind, or data type. ' +
    'x and y are the entity\'s top-left in the current view, and moving one carries its attributes with it in Chen notation. ' +
    'Data types are normalized to the app\'s canonical form. Refer to the shape by id or unique name.',
  inputSchema: {
    node: z.string().describe('Shape id or unique name.'),
    name: z.string().optional().describe('New shape name in the database.'),
    kind: z.string().optional().describe('Entity: strong|weak. Relationship: strong|weak. Attribute: simple|key|unique|multivalued|derived|composite.'),
    dataType: z.string().optional().describe('Attributes only.'),
    x: z.number().optional().describe('Entities only. Left edge in the current view; give both x and y.'),
    y: z.number().optional().describe('Entities only. Top edge in the current view; give both x and y.'),
  },
}, async ({ node, ...patch }) => json(await updateNode(node, patch)));

server.registerTool('remove_node', {
  title: 'Remove a shape',
  description:
    'Delete a shape from the open diagram. Attributes it owns are deleted with it, and lines touching it are removed. ' +
    'Refer to it by id or unique name.',
  inputSchema: {
    node: z.string().describe('Shape id or unique name.'),
  },
}, async ({ node }) => json(await removeDiagramNode(node)));

server.registerTool('update_diagram', {
  title: 'Update the diagram',
  description:
    'Rename the open diagram or switch the notation shown. Chen and crow\'s-foot coordinates are stored separately, so switching never destroys the other view\'s layout.',
  inputSchema: {
    name: z.string().optional().describe('New diagram name.'),
    view: viewSchema.optional().describe('Notation to show: chen (default) or crowfoot.'),
  },
}, async (patch) => json(await updateDiagram(patch)));

server.registerTool('create_share_link', {
  title: 'Create a share link',
  description:
    'Build a URL that opens the open diagram in ERD Maker. The snapshot is embedded by default, so the link works without a server. ' +
    'In a live room the URL points at that room instead, so the AI\'s edits keep streaming to whoever opens it. ' +
    'baseUrl defaults to the live room\'s app URL, then http://localhost:5173/ (or ERD_MCP_APP_URL); room reuses an existing room id instead of generating one.',
  inputSchema: {
    baseUrl: z.string().optional().describe('App origin, e.g. https://erd.example.com/.'),
    room: z.string().optional().describe('Reuses this room, keeping the AI\'s edits live in it.'),
    includeSnapshot: z.boolean().optional().describe('Defaults to true.'),
  },
}, async (options) => json(shareSession(options)));

server.registerTool('list_diagrams', {
  title: 'List saved diagrams',
  description: 'List JSON diagram files in the diagrams folder, newest first, with each diagram\'s stored name when it can be read.',
  inputSchema: {},
}, async () => json({ diagrams: await listDiagramFiles() }));

server.registerResource('current-diagram', 'erd://current', {
  title: 'Current diagram',
  description: 'The open diagram as the JSON document ERD Maker imports.',
  mimeType: 'application/json',
}, async (uri) => {
  const current = peekSession();
  if (!current) return { contents: [{ uri: uri.href, text: 'No diagram is open. Call create_diagram or open_diagram first.' }] };
  return {
    contents: [{
      uri: uri.href,
      mimeType: 'application/json',
      text: JSON.stringify({ filePath: current.filePath, dirty: current.dirty, live: current.live, document: current.doc }, null, 2),
    }],
  };
});

server.registerResource('current-summary', 'erd://current/summary', {
  title: 'Current diagram summary',
  description: 'Entities, columns, relationships, and issues of the open diagram, plus a text outline.',
  mimeType: 'application/json',
}, async (uri) => {
  if (!peekSession()) {
    return { contents: [{ uri: uri.href, text: 'No diagram is open. Call create_diagram or open_diagram first.' }] };
  }
  return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(summarizeSession(), null, 2) }] };
});

server.registerResource('current-sql', 'erd://current/sql', {
  title: 'Current diagram SQL',
  description: 'Standard-dialect DDL for the open diagram, or the reason it cannot be generated yet.',
  mimeType: 'text/plain',
}, async (uri) => {
  if (!peekSession()) {
    return { contents: [{ uri: uri.href, text: 'No diagram is open. Call create_diagram or open_diagram first.' }] };
  }
  try {
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: sqlForSession().sql }] };
  } catch (error) {
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: errorMessage(error) }] };
  }
});

server.registerPrompt('design-erd', {
  title: 'Design an ERD',
  description: 'Work through requirements and produce a validated diagram with SQL.',
  argsSchema: {
    requirements: z.string().describe('What the database must support.'),
    view: viewSchema.optional(),
  },
}, ({ requirements, view }) => ({
  messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: [
        'Design an entity-relationship diagram for these requirements:',
        '',
        requirements,
        '',
        'Use the ERD Maker tools:',
        '1. List entities and their attributes. Mark the identifier of each entity with kind "key" and give attributes a dataType.',
        '2. Describe relationships with cardinality at each end. "1:N" from A to B means one A relates to many Bs. Use N:M when both sides can repeat; the junction table is generated for you.',
        '3. Model a dependent entity as weak when its identity includes a parent\'s key.',
        '4. Place the entities on a grid: give each one an x and y, related entities near each other, about 500px apart across and 360px down in Chen, so the attribute columns and relationship diamonds the app places for you have room. Do not rely on automatic arrangement.',
        '5. If the person wants to watch, call open_room BEFORE create_diagram: pass their share link to join their room, or omit it to start a new one. Every edit then streams into their open tab without a refresh.',
        '6. Call create_diagram once with the whole model — every entity with its attributes listed on it, every relationship, every specialization — then validate_diagram, and fix anything it reports.',
        '7. Run generate_sql and include the DDL, along with the share link from create_diagram.',
        '8. Leave the room open while the person keeps working. Call leave_room when they say they are done, or ask you to leave — your turn ending is not them being done.',
        '9. Model specializations with add_isa: a parent entity and every subclass that inherits its keys and values, added after create_diagram.',
        view ? `Show the diagram in the ${view} view after creating it.` : '',
        '',
        'Use the vocabulary of the requirements and do not invent attributes they do not imply.',
      ].filter(Boolean).join('\n'),
    },
  }],
}));

  return server;
}

// stdio is the default. `main.ts` sets ERD_MCP_TRANSPORT=http to pick the other
// entry point, so this module can also be imported by `http.ts` without
// grabbing stdin.
if (process.env.ERD_MCP_TRANSPORT !== 'http') {
  const transport = new StdioServerTransport();

  createServer().connect(transport).then(
    () => console.error(`ERD Maker MCP ready. Workspace: ${WORKSPACE_ROOT}`),
    (error: unknown) => {
      console.error('ERD Maker MCP failed to start:', errorMessage(error));
      process.exit(1);
    },
  );
}
