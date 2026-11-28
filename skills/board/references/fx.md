<!-- Adapted from vercel/board's agent skill (skills/board, Apache-2.0) at commit
34d0f584f9446b05d3afbfa73c696e1bf31c043d. Not ported: upstream's page is replaced by this note. -->

# fx

Upstream's skill has a page mapping fx's `subagent` tool onto board commands.
It isn't ported to bordeaux yet.

The board side of the mapping is protocol, so it is the same on bordeaux:
starting a subagent is a task (`bdx tasks create`), messaging it is a reply in
the task's thread, and its final report is `bdx tasks complete`. Start from
[SKILL.md](../SKILL.md) and [swarm.md](swarm.md).
