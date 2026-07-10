# Mapping Failover Drag Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an administrator reorder each model's failover mappings with a drag handle instead of up/down buttons.

**Architecture:** Keep persistence on the existing atomic `PUT /admin/mappings/reorder` route. Add a small pure frontend utility for immutable list movement, test it with Node's built-in test runner, then use native HTML drag events and an accessible keyboard fallback in `Mappings.jsx`.

**Tech Stack:** React 18, TanStack Query, Tailwind CSS, Lucide React, Node built-in test runner.

---

### Task 1: Test and implement the immutable reorder utility

**Files:**
- Create: `web/src/lib/reorder.js`
- Create: `web/src/lib/reorder.test.js`
- Modify: `web/package.json`

- [x] **Step 1: Write the failing test**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { moveItem } from './reorder.js'

test('moves an item to the requested index without mutating the source', () => {
  const source = [1, 2, 3]
  assert.deepEqual(moveItem(source, 0, 2), [2, 3, 1])
  assert.deepEqual(source, [1, 2, 3])
})

test('returns the original ordering for invalid or unchanged positions', () => {
  const source = [1, 2, 3]
  assert.deepEqual(moveItem(source, 1, 1), source)
  assert.deepEqual(moveItem(source, -1, 1), source)
  assert.deepEqual(moveItem(source, 0, 3), source)
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test web/src/lib/reorder.test.js`

Expected: FAIL because `./reorder.js` does not exist.

- [x] **Step 3: Add the minimal utility and test script**

```js
export function moveItem(items, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) return [...items]
  const reordered = [...items]
  const [item] = reordered.splice(fromIndex, 1)
  reordered.splice(toIndex, 0, item)
  return reordered
}
```

```json
"test": "node --test src/**/*.test.js"
```

- [x] **Step 4: Run the test to verify it passes**

Run: `npm run test --prefix web`

Expected: PASS with 2 passing tests.

### Task 2: Replace arrow controls with drag-and-drop queue ordering

**Files:**
- Modify: `web/src/pages/Mappings.jsx`
- Modify: `web/src/lib/reorder.js`
- Modify: `web/src/lib/reorder.test.js`

- [x] **Step 1: Write a failing test for the keyboard movement target**

```js
test('clamps a keyboard move target to the queue boundaries', () => {
  assert.equal(moveTarget(0, -1, 3), 0)
  assert.equal(moveTarget(2, 1, 3), 2)
  assert.equal(moveTarget(1, 1, 3), 2)
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm run test --prefix web`

Expected: FAIL because `moveTarget` has not yet been exported.

- [x] **Step 3: Implement native drag and keyboard interactions**

Export `moveTarget(index, direction, length)` from `reorder.js` and use it with `moveItem(rows, fromIndex, toIndex)` to build the complete mapping ID list. Keep drag state local to each `MappingRows` instance; prevent cross-group drops by accepting only its own drag source. On drop, call the existing `onReorder(orderedRows)` callback. Replace `ArrowUp`/`ArrowDown` imports and buttons with the `GripVertical` Lucide icon inside a labeled `button`; support Enter/Space pickup, ArrowUp/ArrowDown movement, and Enter/Space/Escape release.

- [x] **Step 4: Run unit tests and production build**

Run: `npm run test --prefix web`

Expected: PASS with 3 passing tests.

Run: `npm run build --prefix web`

Expected: Vite completes with exit code 0.

### Task 3: Validate the completed diff and commit

**Files:**
- Modify: `web/package.json`
- Create: `web/src/lib/reorder.js`
- Create: `web/src/lib/reorder.test.js`
- Modify: `web/src/pages/Mappings.jsx`

- [x] **Step 1: Inspect the scoped diff**

Run: `git diff --check -- web/package.json web/src/lib/reorder.js web/src/lib/reorder.test.js web/src/pages/Mappings.jsx`

Expected: no whitespace errors.

- [x] **Step 2: Run final verification**

Run: `npm run test --prefix web; npm run build --prefix web`

Expected: unit tests and production build both pass.

- [x] **Step 3: Commit only the feature files**

```bash
git add web/package.json web/src/lib/reorder.js web/src/lib/reorder.test.js web/src/pages/Mappings.jsx docs/superpowers/plans/2026-07-10-mapping-failover-drag-sort.md
git commit -m "feat: drag-sort mapping failover queues"
```
