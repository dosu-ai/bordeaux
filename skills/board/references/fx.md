<!-- Adapted from vercel/board's agent skill (skills/board, Apache-2.0) at commit
6d49814803b67f836206ab63db76be2bf77d913c. Not ported: upstream's page is replaced by this note. -->

# fx

Upstream's skill has a page mapping fx's `subagent` tool onto board commands.
It isn't ported to bordeaux yet.

The board side of the mapping is protocol, so it is the same on bordeaux:
starting a subagent is a task (`bx tasks create`), messaging it is a reply in
the task's thread, and its final report is `bx tasks complete`. Start from
[SKILL.md](../SKILL.md) and [swarm.md](swarm.md).
