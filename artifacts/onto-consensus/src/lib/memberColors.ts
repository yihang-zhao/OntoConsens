// Canonical per-member color mapping used everywhere a member's identity is
// shown: avatar chips, cursors, property proposer/agreement dots. colorSlot
// comes from the backend (0 = owner/first joiner, 1 = second, 2 = third).
// The actual hue values live in src/index.css as --member-0/1/2 (HSL triples)
// so the whole app (including this file) stays in sync with one source of truth.
export interface MemberColor {
  solid: string; // opaque background for solid chips/dots/cursors
  soft: string; // tinted background for cards/badges
  softText: string; // readable text/icon color over `soft`
  ring: string; // border/ring color
}

function memberColor(slot: number): MemberColor {
  const varName = `--member-${slot}`;
  return {
    solid: `hsl(var(${varName}))`,
    soft: `hsl(var(${varName}) / 0.14)`,
    softText: `hsl(var(${varName}))`,
    ring: `hsl(var(${varName}) / 0.5)`,
  };
}

export const MEMBER_COLORS: MemberColor[] = [
  memberColor(0),
  memberColor(1),
  memberColor(2),
];

export function colorForSlot(colorSlot: number): MemberColor {
  return MEMBER_COLORS[colorSlot % MEMBER_COLORS.length] ?? MEMBER_COLORS[0]!;
}
