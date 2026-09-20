// Russian number agreement, for the parts of the site that speak to the user.
//
// "1 серия", "2 серии", "5 серий" — a count and a noun cannot simply be
// concatenated, and text that gets this wrong reads as machine output.
export const plural = (count, one, few, many) => {
  const value = Math.abs(Number(count) || 0);
  const mod10 = value % 10;
  const mod100 = value % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

/** A number with its noun in the right form. */
export const counted = (value, one, few, many) =>
  `${Number(value).toLocaleString("ru-RU")} ${plural(value, one, few, many)}`;
