declare module 'qz-tray' {
  const qz: {
    websocket: {
      connect: () => Promise<void>;
      disconnect: () => Promise<void>;
      isActive: () => boolean;
    };
    printers: {
      find: (query?: string) => Promise<string | string[]>;
    };
    configs: {
      create: (printer: string, options?: Record<string, unknown>) => unknown;
    };
    print: (config: unknown, data: unknown[]) => Promise<void>;
  };
  export default qz;
}
