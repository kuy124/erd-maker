const paths = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  select: 'm5 3 14 10-7 1-3 7Z',
  connect: 'M7 8V5h10v3M7 16v3h10v-3M4 8h6v8H4ZM14 8h6v8h-6Z',
  pan: 'M8 12V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v6c0 4-3 6-6 6h-2c-2 0-3-1-4-3l-4-5a1.5 1.5 0 0 1 2-2Z',
  build: 'M12 5v14M5 12h14',
  diagram: 'M4 4h6v6H4ZM14 14h6v6h-6ZM7 10v7h7M14 4h6v6h-6Z',
  properties: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  help: 'M9 8a3 3 0 0 1 6 0c0 3-3 2-3 5M12 17v.1',
  arrange: 'M3 4h6v6H3ZM15 4h6v6h-6ZM9 15h6v6H9ZM9 7h6M6 10v8h3M18 10v8h-3',
  export: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  focus: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
} as const;

export function WorkspaceIcon({ name }: { name: keyof typeof paths }) {
  return <svg className="workspace-icon" width="20" height="20" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
