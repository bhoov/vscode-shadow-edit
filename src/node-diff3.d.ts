declare module 'node-diff3' {
  export function diffIndices<T>(a: T[], b: T[]): Array<{ buffer1: [number, number]; buffer1Content: T[]; buffer2: [number, number]; buffer2Content: T[] }>;
}
