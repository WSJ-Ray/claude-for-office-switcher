# Mapping Failover Drag Sort Design

## Goal

Replace the model-mapping failover queue's up/down controls with mouse drag-and-drop sorting.

## Scope

The change applies only to `web/src/pages/Mappings.jsx`. Each client-model group remains an independent queue. Existing backend ordering, validation, and the `PUT /admin/mappings/reorder` endpoint remain unchanged.

## Interaction

- Each mapping row exposes a visible drag handle.
- A mapping can be dragged only within its own client-model group.
- The list shows a drop-position state while a row is over a valid target.
- On drop, the frontend submits every mapping ID in the group, in its new order, to the existing atomic reorder endpoint.
- While a reorder request is pending, starting another reorder is blocked.
- Reorder failures use the existing inline error state and refresh the query so the server's saved order is rendered again.
- The up/down buttons are removed. Editing, enable/disable, and deletion retain their current behavior.

## Accessibility

The drag handle is a labeled button so its purpose is discoverable to assistive technology. Keyboard users retain a fallback interaction: focus the handle, press Enter or Space to pick up the row, then use ArrowUp/ArrowDown to move it; Enter, Space, or Escape releases it.

## Testing

Extract order-manipulation into a small pure utility and cover row movement, boundaries, and no-op moves with unit tests. Build the Vite app after the component integration change.
