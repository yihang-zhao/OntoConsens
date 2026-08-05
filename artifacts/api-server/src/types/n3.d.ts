declare module "n3" {
  export interface Term {
    value: string;
    termType: string;
  }

  export interface Quad {
    subject: Term;
    predicate: Term;
    object: Term;
  }

  export interface ParserOptions {
    format?: string;
  }

  export class Parser {
    constructor(options?: ParserOptions);
    parse(
      input: string,
      callback: (error: Error | null, quad: Quad | null) => void,
    ): void;
  }
}
