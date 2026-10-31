# ERD Maker MCP — the 30-second version

**You do not need to clone this repository.** The server is one file that needs
only Node 20+.

```bash
# download once
curl -O https://raw.githubusercontent.com/kuy124/erd-maker/main/mcp/dist/erd-maker-mcp.mjs

# stdio (an MCP client launches it)
node erd-maker-mcp.mjs

# or serve it over HTTP, nothing to install on the client
node erd-maker-mcp.mjs --http        # http://127.0.0.1:8787/mcp
```

Client config (stdio):

```json
{ "mcpServers": { "erd-maker": {
  "command": "node",
  "args": ["/absolute/path/to/erd-maker-mcp.mjs"],
  "env": { "ERD_MCP_ROOT": "/absolute/path/to/your/project" }
} } }
```

Client config (HTTP):

```json
{ "mcpServers": { "erd-maker": {
  "type": "http",
  "url": "http://127.0.0.1:8787/mcp"
} } }
```

## What it does

Authors entity-relationship diagrams as JSON files on disk, in Chen or
crow's-foot notation, and generates `CREATE TABLE` DDL from them.

## The one call that matters

`create_diagram` takes the whole model as **indented text**, so you never have
to hand-write nested JSON:

```
create_diagram { "name": "Shop", "text": "
  Customer
    customer_id: INT key
    email: TEXT unique
  Order
    order_id: INT key
    placed_at: TIMESTAMP
  Customer 1:N Order as places
"}
```

Rules, all of them:

| Line | Means |
| --- | --- |
| `Customer` | an entity (unindented) |
| `  name: TEXT` | an attribute of the entity above it |
| `  name: TEXT key` | …with kind `key` (also `unique`, `multivalued`, `derived`, `composite`) |
| `  address: composite` | a composite; indent its parts underneath |
| `Customer 1:N Order as places` | a relationship; cardinality is `from:to` |
| `Party isa Customer, Supplier` | a specialization |
| `Supplier @ 900,120` | optional position, top-left in pixels |

Then call `validate_diagram`, fix what it reports, and call `generate_sql`.

Layout is automatic. Positions are optional — leave them out unless you want a
specific arrangement.

## Cardinality, the one thing to get right

`1:N` **from** A **to** B means *one A relates to many Bs*. The label at each
end describes the entity at that end.

## Tools

`server_status`, `create_diagram`, `open_diagram`, `save_diagram`,
`get_diagram`, `summarize_diagram`, `validate_diagram`, `generate_sql`,
`arrange_diagram`, `add_entity`, `add_attribute`, `add_relationship`,
`add_isa`, `update_node`, `remove_node`, `update_diagram`, `list_diagrams`,
`open_room`, `leave_room`, `create_share_link`.

Prefer `create_diagram` with `text` for a first draft. Reach for the `add_*` /
`update_*` tools only for follow-up edits.

## Live rooms (optional)

`open_room` joins a collaborative session so a human watches edits stream into
their browser tab. Call it before `create_diagram` when someone wants to watch,
and `leave_room` only when they say they are done — not when your turn ends.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `ERD_MCP_ROOT` | the checkout, or cwd for a bundle | folder diagrams live under |
| `ERD_MCP_DIR` | `diagrams` | subfolder for new diagrams |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | HTTP transport bind address |

## Building from source

```bash
npm install
node mcp/build.mjs          # -> mcp/dist/erd-maker-mcp.mjs
node mcp/verify.mjs         # proves the bundle runs with no node_modules
node mcp/verify-http.mjs    # same over HTTP
```
