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
  type AddIsaSpec,
} from './diagram';

const server = new McpServer(
  { name: 'erd-maker', version: '1.0.0' },
  {
    instructions: [
      'Read, author, and export entity-relationship diagrams for ERD Maker, stored as JSON files under',
      WORKSPACE_ROOT + '.',
      '',
      'One diagram is open at a time: create_diagram or open_diagram makes it current, the add/update/remove',
      'tools edit it, and every edit is written back to its file. Shapes can be referenced by id or by a',
      'unique name; summarize_diagram returns both.',
      '',
      'Place shapes by coordinates: create_diagram and update_node take x and y for an ENTITY, its top-left in',
      'the view you are creating. Only entities take coordinates — the attribute column, the relationship',
      'diamonds, and the lines are placed for you, so leave them room instead of trying to position them. In',
      'Chen an entity is 150x60 and the app stacks its attributes beside it at 80px a row, on whichever side',
      'fits, so one with four attributes needs roughly 340px across and 300px down: keep about 500px between',
      'the top-left x of two entities on a row and 360px between rows. In crow\'s-foot a table is 280 wide',
      'and grows 44px per column, so leave about 360px across.',
      'summarize_diagram reports every position, so read it before moving anything; layout:true or',
      'arrange_diagram hands the whole job to the app\'s own layout when you would rather not place anything.',
      '',
      'Live rooms: open_room joins an ERD Maker room as a collaborator, so every later edit appears in the',
      'room\'s open tabs as it happens, with the AI\'s name, cursor, and selection, and no refresh. Omit the',
      'link to start a room, or pass the share link the person gave you to join theirs. A room that already',
      'has content wins; the open diagram or the link\'s snapshot only seeds an empty room. While in a room,',
      'create_share_link returns that same room, so the AI\'s edits stay live for whoever opens it. Edits are',
      'authored in view: the pointer travels to each shape, clicks it, and the shape appears under it, one',
      'continuous stroke across the whole diagram.',
      '',
      'leave_room signs out with a visible farewell: it glides back to the last shape, pauses with the typing',
      'indicator up, then leaves, so the room sees a departure instead of an avatar that stopped moving. Call it',
      'when the person says they are done, or when they ask the assistant to leave — and not otherwise. Your own',
      'turn ending is not the person being done, and neither is one finished edit: stay in the room while they keep',
      'working, however many turns that takes, and keep editing in the same room. Rejoining with open_room puts the',
      'pointer back where it left off.',
      '',
      'Cardinality "1:N" from A to B means one A relates to many Bs; the label at each end describes the',
      'entity at that end. Attribute kinds are simple, key, unique, multivalued, derived, and composite;',
      'composite attributes own their parts.',
      'A key attribute carries the primary key, and every value of a key attribute must be unique.',
      '',
      'Typical flow: one create_diagram holding the whole model — every entity with its attributes listed on it,',
      'every relationship with its cardinality, every specialization — then validate_diagram, fix what it reports,',
      'then generate_sql. Use the add/update/remove tools for follow-ups, not for building the first draft.',
      'create_share_link produces a URL that opens the diagram in the app.',
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
    'Build an ERD from a complete description and open it as the current diagram. List every entity with its attributes, then relationships between entities by name, then optional specializations. ' +
    'Entities keep the x and y you give them. Give every entity coordinates or none at all: a diagram with no coordinates is auto-arranged by the app\'s layout engine, while a partially placed one keeps the given positions and parks the rest beside their owners. ' +
    'Pass layout:true to arrange anyway and layout:false to keep free-slot placement. ' +
    'The diagram is validated and saved to diagrams/<slug>.json unless path or save:false says otherwise. ' +
    'In a live room the new diagram replaces the room content and streams in shape by shape for whoever is watching. ' +
    'Returns the file path, a text outline, validation issues, and a share link that opens it in ERD Maker.',
  inputSchema: {
    name: z.string().describe('Diagram name, e.g. "Sales".'),
    view: viewSchema.optional().describe('Notation to show: chen (default) or crowfoot.'),
    entities: z.array(entitySpecSchema).min(1).describe('Every entity with its attributes, keys, and positions.'),
    relationships: z.array(relationshipSpecSchema).optional().describe('Every relationship between two entities with its cardinality.'),
    isas: z.array(isaSpecSchema).optional().describe('Every specialization of a base by its subclasses.'),
    path: z.string().optional().describe('Workspace-relative .json path. Omit to use diagrams/<name>.json.'),
    overwrite: z.boolean().optional().describe('Replace the file at path if it already exists.'),
    layout: z.boolean().optional().describe('Auto-arrange the whole diagram. Defaults to auto-arrange when no entity has coordinates; otherwise the x and y you give are kept and shapes without coordinates take the first free slot.'),
    save: z.boolean().optional().describe('Set false to keep the diagram only in this session.'),
  },
}, async (spec) => json(await createDiagram(spec)));

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

const transport = new StdioServerTransport();

server.connect(transport).then(
  () => console.error(`ERD Maker MCP ready. Workspace: ${WORKSPACE_ROOT}`),
  (error: unknown) => {
    console.error('ERD Maker MCP failed to start:', errorMessage(error));
    process.exit(1);
  },
);
