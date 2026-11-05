---
name: system-triage
description: Find out why the machine is slow, hot, full or noisy — and say the fix in one line.
when:
  - slow
  - lagging
  - hanging
  - fan
  - noisy
  - hot
  - overheat
  - disk full
  - out of space
  - ram
  - cpu
  - high load
  - freezing
  - performance
  - speed up
tags: [system, performance, fedora, diagnostic]
tools: [system_status, disk_space, list_windows, shell]
version: 1.0.0
---

# System triage

Use when the owner says anything like "PC slow hai", "fan loud", "disk full", "kya chal raha hai", "why is it lagging".

## Procedure

1. `system_status` — read CPU, memory, load and battery. Load above the core count means something is saturating the machine.
2. `disk_space` — if root or home is above 90% used, that is the answer; say which directory to clean (`~/.cache`, `~/.local/share/Trash`, old downloads).
3. `list_windows` — an obvious culprit (Chrome with 40 tabs, a VM, a render) is often right there.
4. Only if shell is available: `ps -eo pcpu,pmem,comm --sort=-pcpu | head -8` for the real offenders.

## Answer shape

Three lines maximum:

```
<one-line verdict>
<the number that proves it>
<the fix, as a command or an action>
```

Example:

```
CPU is pegged by one process, not the system.
node is at 187% and load is 7.2 on 4 cores.
Fix: kill it (`pkill -f node`) or tell me "stop node".
```

Do not paste raw `/proc` output. Do not list ten processes.
