// Hit-testing for sliding segmented pickers: maps a pointer position to a selectable option.

// Returns the enabled option nearest to clientX (zero distance while inside its bounds).
// A pointer over a disabled segment resolves to its closest enabled neighbour, so a drag
// never stalls on an unavailable choice. Equal distances keep the leftmost segment.
// Returns -1 when nothing is selectable.
export function segmentAt(items, options, clientX) {
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < items.length; index += 1) {
    if (options[index]?.disabled) continue;
    const rect = items[index].getBoundingClientRect();
    if (!rect.width) continue;
    const distance = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}
