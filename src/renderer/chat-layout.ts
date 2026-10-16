export function stackTop(toolbar: Pick<DOMRect, 'bottom'>, gap = 8) {
  return toolbar.bottom + gap
}