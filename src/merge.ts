import { diffIndices } from 'node-diff3';

const lines = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
type Edit = { start: number; end: number; text: string[]; side: number };

// Insertions at a replacement boundary are independent; insertions at the same
// point and insertions inside a replaced range require conflict resolution.
function overlaps(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return Math.max(a.start, b.start) < Math.min(a.end, b.end);
}

export function merge(base: string, mine: string, theirs: string): { content: string; conflicts: number } {
  const original = lines(base);
  const edits: Edit[] = [mine, theirs].flatMap((s, side) => diffIndices(original, lines(s)).map(d => ({ start: d.buffer1[0], end: d.buffer1[0] + d.buffer1[1], text: d.buffer2Content, side })));
  edits.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = 0, content = '', conflicts = 0;
  while (edits.length) {
    const group = [edits.shift()!];
    for (let i = 0; i < edits.length;) {
      if (group.some(e => overlaps(e, edits[i]))) { group.push(edits.splice(i, 1)[0]); i = 0; } else i++;
    }
    const start = Math.min(...group.map(e => e.start)), end = Math.max(...group.map(e => e.end));
    content += original.slice(cursor, start).join('');
    const render = (side: number) => {
      let at = start, result = '';
      for (const e of group.filter(e => e.side === side).sort((a, b) => a.start - b.start)) {
        result += original.slice(at, e.start).join('') + e.text.join(''); at = e.end;
      }
      return result + original.slice(at, end).join('');
    };
    const a = render(0), b = render(1);
    if (group.every(e => e.side === group[0].side)) content += render(group[0].side);
    else if (a === b) content += a;
    else {
      conflicts++;
      const terminated = (s: string) => s && !s.endsWith('\n') ? s + '\n' : s;
      content += '<<<<<<< MINE\n' + terminated(a) + '||||||| BASE\n' + terminated(original.slice(start, end).join('')) + '=======\n' + terminated(b) + '>>>>>>> THEIRS\n';
    }
    cursor = end;
  }
  return { content: content + original.slice(cursor).join(''), conflicts };
}

export const hasMarkers = (s: string): boolean => /^(<{7}|\|{7}|={7}|>{7})(?:\s|$)/m.test(s);
