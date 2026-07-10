export function moveItem(items, fromIndex, toIndex) {
  if (
    fromIndex === toIndex
    || fromIndex < 0
    || toIndex < 0
    || fromIndex >= items.length
    || toIndex >= items.length
  ) return [...items]

  const reordered = [...items]
  const [item] = reordered.splice(fromIndex, 1)
  reordered.splice(toIndex, 0, item)
  return reordered
}

export function moveTarget(index, direction, length) {
  return Math.max(0, Math.min(length - 1, index + direction))
}
