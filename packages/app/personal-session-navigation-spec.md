# Personal Session Navigation

## Goal

Replace the crowded titlebar tab strip with one primary session navigator in the Personal rail, and make direct child-agent sessions visible and inspectable without exposing Ensemble internals to the App.

The primary scenario is a user coordinating several open conversations and watching background agents. They should be able to switch root conversations from the left rail, inspect a child agent from the right rail, and return to the owning conversation without losing orientation.

## In Scope

### Left rail

- The Personal rail is the only visual list of open root sessions and drafts.
- Its default mode groups entries by project, preserving the existing project collapse and attention behavior.
- A compact mode control switches between project groups and one flat list.
- The flat list supports last-active and A-Z ordering. Both the mode and flat-list ordering persist locally.
- Child sessions never appear in the left rail.
- A session row context menu exposes the same applicable rename, close-tab, and archive actions as its existing controls. Drafts expose only valid draft actions.

### Titlebar

- Remove the horizontal multi-tab strip from the Personal shell.
- Show the current route title in its place.
- Preserve Home, new-session, close-tab, reopen-closed-tab, previous/next tab, and drag-independent keyboard navigation behavior.

### Child-agent rail

- A root session shows a right rail containing its direct, non-archived child sessions (`parentID === root.id`).
- A child route remains anchored to its root and shows the same sibling list plus a clear return-to-root action.
- The list uses native session status and request state, with attention/running states before recent idle children.
- Selecting a child renders its complete live transcript and tool activity in the main content area.
- A child selected from this rail is an observation surface: the composer and other prompt-producing controls are unavailable.
- The first delivery does not render grandchildren or expose Ensemble-specific task, branch, role, model, or lifecycle metadata.

### Responsive behavior

- The right rail is persistent only at desktop widths.
- Below 1080px, a titlebar control opens the same child list in a right-side drawer.
- Selecting a child from the drawer closes it and navigates to the read-only child route.

## Non-Goals

- Listing closed session history in the Personal rail.
- Retaining the horizontal titlebar tab strip.
- Sending prompts directly into an observed child session.
- A permanently split parent/child transcript view.
- A recursive descendant tree.
- Reading the Ensemble SQLite database or introducing an App dependency on the Ensemble plugin.

## Existing Interfaces

- OpenCode sessions already expose `parentID` and a children endpoint.
- The App sync store retains child sessions received through events and directory hydration.
- Ensemble creates teammate sessions with `parentID` set to the lead session ID. This contract needs integration coverage, not a new plugin transport.
- Personal navigation already owns native tab selection, session rename, close, archive, status projection, and responsive left-drawer behavior.

## Acceptance Evidence

1. Project and flat modes render only open root sessions and drafts. Last-active and A-Z ordering are deterministic, and preferences survive a reload.
2. Right-clicking a session row opens the same applicable action set as the visible menu/control path. Keyboard access, disabled states, focus return, and action outcomes remain equivalent.
3. The Personal titlebar renders one current title instead of the horizontal tab strip while existing tab commands continue to work.
4. A newly spawned Ensemble teammate appears under the correct root without a reload, and busy, retry, idle, error, question, and permission state changes update live.
5. Selecting a direct child shows its complete transcript and tool activity, exposes no prompt composer, retains the owning root's child rail, and provides a working return-to-root action.
6. Children from another root and grandchildren do not appear in the current root's list.
7. At widths below 1080px the child list is available through an accessible right drawer; desktop and narrow layouts have no incoherent overlap or horizontal page overflow.
8. Focus visibility, keyboard navigation, 200% text zoom, reduced motion, and empty/loading/error states are covered by focused browser acceptance.

## Assumptions

- "Last active" uses the session's native updated timestamp; drafts remain available but do not fabricate server activity.
- Observation mode is a presentation restriction. Existing session APIs and Team coordination semantics remain unchanged.
- The existing Personal attention projection remains separate from the open-session sequence.
