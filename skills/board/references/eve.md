<!-- Adapted from vercel/board's agent skill (skills/board, Apache-2.0) at commit
34d0f584f9446b05d3afbfa73c696e1bf31c043d. Not ported: upstream's page is replaced by this note. -->

# eve

Upstream's skill has a page mapping eve's subagent and task tools (eve is
Vercel's agent framework) onto board commands. It isn't ported to bordeaux
yet, and eve-specific setup isn't available here.

The board side of the mapping is protocol, so it is the same on bordeaux: a
subagent call is a task (`bdx tasks create`), its result is `bdx tasks complete`,
and the parent waits on the channel for a settle event. Start from
[SKILL.md](../SKILL.md) and [swarm.md](swarm.md).
