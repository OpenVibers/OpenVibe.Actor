# Actor's rich embeds: handed to the v2-4 session

The shared agent session (openvibe-shared v4.50.0) draws the images and files a step read, wrote or produced, when a
line carries `attachments: [{ url, name, mime, size?, kind, role }]`.

What this branch had started: the v2 loop's `tool_result` event mapping a tool's `artifacts` into those attachments
(`server/runtime/loop.js`), so a tool that produces a picture shows it in the session.

**It is not finished here on purpose.** Actor's task events are a public contract — `actor.task-event@1`, validated
against the schema in `test/tasks.test.js` — and `additionalProperties` is false. So the attachments need a field
declared in OpenVibe.Contracts first (a schema change and a release), and only then the event, the page's line mapping
and the pin.

The v2-4 session (`actor-v2-4-compute`) is doing that work, and it owns Actor's attachments from here. This branch
keeps the mapper as the starting point; the branch itself is not ready to merge.
