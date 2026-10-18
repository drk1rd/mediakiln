declare module "@11ty/eleventy" {
  interface EleventyUserConfig {
    addPassthroughCopy(path: string): void;
    addPlugin(plugin: unknown, options?: unknown): void;
  }
  export default class Eleventy {
    constructor(
      input: string,
      output: string,
      options?: {
        quietMode?: boolean;
        runMode?: string;
        config?: (cfg: EleventyUserConfig) => void;
      },
    );
    write(): Promise<unknown>;
  }
}
