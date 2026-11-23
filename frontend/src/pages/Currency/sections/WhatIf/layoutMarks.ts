/** One label on the slider track: where its tick is and how wide its text is, in px. */
export interface MarkBox {
  /** Tick position along the track, in px. */
  x: number;
  /** Estimated text width, in px. */
  w: number;
}

export interface MarkPlacement {
  /** 0 = the row right under the track; deeper rows sit lower. */
  lane: number;
  /** Where the text starts relative to its tick, in px (negative near the right edge). */
  dx: number;
}

const GAP = 8;
const MAX_LANES = 5;
const STEM_PAD = 2;

/**
 * Collision-safe label rows for ticks on a track. Each label hangs from its tick on a
 * stem; near the right edge the text is pulled left so it stays on the track. A label
 * that holds another tick inside its span goes deeper than that one, so a stem never
 * crosses a neighbor's text. Pure presentation geometry.
 */
export function layoutMarks(boxes: MarkBox[], width: number): MarkPlacement[] {
  const spans = boxes.map((b) => {
    const l = Math.max(0, Math.min(b.x - STEM_PAD, width - b.w));
    return { l, r: l + b.w };
  });
  const lanes = boxes.map(() => 0);
  const holds = (i: number, j: number) => boxes[j]!.x >= spans[i]!.l - STEM_PAD && boxes[j]!.x <= spans[i]!.r + GAP;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue;
        const leftOf = boxes[i]!.x < boxes[j]!.x || (boxes[i]!.x === boxes[j]!.x && i < j);
        const mutual = holds(i, j) && holds(j, i);
        const overlap = spans[i]!.l < spans[j]!.r + GAP && spans[j]!.l < spans[i]!.r + GAP;
        // Deeper: the label that holds the other's tick; for a mutual hold or a plain
        // overlap, the left one.
        const bump = mutual || (!holds(i, j) && overlap) ? leftOf && lanes[i]! <= lanes[j]! : holds(i, j) && lanes[i]! <= lanes[j]!;
        if (bump) {
          lanes[i] = Math.min(MAX_LANES - 1, lanes[j]! + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return spans.map((s, i) => ({ lane: lanes[i]!, dx: s.l - boxes[i]!.x }));
}
