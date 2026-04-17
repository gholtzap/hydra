# Parallel Worktrees for Hydra

Status: Draft

## Background

I often see people say, "Git worktrees are awesome," and the response from most people is, "What are worktrees?"

Most users do not know what worktrees are, when they help, or how to use them safely. But in agentic development, the value is obvious: if several agents are working on the same project at the same time, they should not all be fighting over one shared checkout.

I already use worktrees in my own workflow for this reason. It works well, but it is still a power-user pattern. You have to know Git, remember the commands, manage extra checkouts, and think about how to merge the results back together cleanly.

That leads to a simple product idea:

What if Hydra used and managed worktrees for the user, so they get the benefits without needing to learn the workflow themselves?

## Summary

There are two main goals:

- Hydra should support an opt-in mode where each agent session runs in its own Git worktree instead of the shared project checkout.
- Hydra should keep parallel sessions aware of each other so overlapping work is easier to spot and manage.

## Problem

Hydra is built for people managing many agents at once. But when several agents work in the same repository at the same time, a few predictable problems show up:

- One session can accidentally capture another session's uncommitted edits in a later commit.
- Agents working in the same checkout run into dirty state, lockfiles, generated files, and branch changes from each other.
- Sessions block each other because the repo becomes one shared mutable workspace.
- Users who want true parallel work today have to teach the workflow themselves through repo instructions and hope the agent follows it correctly.

The result is that Hydra can coordinate many agents at the UI level, but the underlying Git workspace is still a bottleneck.

## Solution

Hydra should offer a first-class "Isolated Worktree" mode for agent sessions.

In this mode, when a user launches a new task, Hydra gives that session its own isolated checkout behind the scenes. From the user's perspective, the experience stays simple:

- Start several tasks in parallel.
- Each agent gets its own safe place to work.
- Hydra keeps the tasks separate instead of piling them into one shared checkout.

This turns worktrees from an expert Git trick into a product feature.

Hydra should also add a lightweight coordination layer for parallel work. If two sessions appear to be heading toward the same area of the codebase, Hydra can warn the user, show the overlap, and help them decide whether to continue, wait, or redirect one of the tasks.

The goal is not to promise that conflicts can never happen. The goal is to make parallel work the default-safe path instead of the default-risky one.

## What This Unlocks

If Hydra manages worktrees well, users get a much better parallel development experience:

- Running many agents at once becomes practical, not fragile.
- Users no longer need to know Git worktree commands to benefit from them.
- Hydra feels meaningfully better than a plain terminal tab manager because it is managing isolation, not just spawning more sessions.
- Teams can understand the value of worktrees through Hydra's workflow instead of vague advice online.

This is also a strong product story. A lot of people have heard that worktrees are powerful, but very few tools explain them through a real user outcome. Hydra can make that concrete:

"You want multiple agents working on one repo at the same time? Turn on isolated worktrees and Hydra handles the messy part."

## Why This Fits Hydra

This idea matches what Hydra is already for.

Hydra is not just a wrapper around coding agents. It is a tool for managing parallel agent work. Once parallel work becomes the core use case, workspace isolation stops being an advanced Git optimization and starts becoming part of the product.

If Hydra owns this experience, users do not need to:

- learn worktree commands,
- invent their own repo instructions,
- manually separate concurrent tasks,
- or constantly clean up after agents collide in one checkout.

Hydra can make the safer workflow feel like the normal workflow.

## Open Questions

- Should isolated worktrees be off by default at first, or enabled automatically when a user starts multiple sessions in one repo?
- How much should Hydra help coordinate overlapping work between sessions?
- How much of the branch/merge workflow should Hydra handle for the user versus simply surfacing the isolated checkouts?

## Recommendation

We should explore this as a core Hydra feature, not as a repo-instructions trick.

The product idea is simple:

Hydra makes parallel agent work safer by isolating each task in its own worktree and helping users avoid overlapping edits.

That is easy to explain, useful immediately, and differentiated in a way users can feel.
