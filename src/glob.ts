import picomatch from "picomatch";

/** Same `new Glob(pattern).match(path)` shape the engine used under Bun, backed by picomatch. */
export class Glob {
  readonly match: (path: string) => boolean;
  constructor(pattern: string) {
    this.match = picomatch(pattern, { dot: true });
  }
}
