const paths = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  select: 'm5 3 14 10-7 1-3 7Z',
  connect: 'M7 8V5h10v3M7 16v3h10v-3M4 8h6v8H4ZM14 8h6v8h-6Z',
  pan: 'M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v6c0 4-3 6-6 6h-2c-2 0-3-1-4-3l-4-5a1.5 1.5 0 0 1 2-2Z',
  build: 'M12 5v14M5 12h14',
  diagram: 'M4 4h6v6H4ZM14 14h6v6h-6ZM7 10v7h7M14 4h6v6h-6Z',
  properties: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  comments: 'M4 4h16v12H9l-5 4ZM8 8h8M8 12h5',
  pin: 'M12 21s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12ZM12 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  search: 'M21 21l-5-5M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z',
  close: 'm6 6 12 12M6 18 18 6',
  send: 'm4 11 16-7-7 16-2-7-7-2Zm7 2 9-9',
  trash: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  help: 'M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5M12 17v.1',
  arrange: 'M3 4h6v6H3ZM15 4h6v6h-6ZM9 15h6v6H9ZM9 7h6M6 10v8h3M18 10v8h-3',
  history: 'M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16m0 3v5l3 2',
  export: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  focus: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
} as const;

export function WorkspaceIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="workspace-icon" width="20" height="20" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
