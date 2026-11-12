# Strata guide

This is the detailed user reference for Strata: what the graph shows and
everything you can do from it. The [README](../README.md) has the overview, how
to get started and the requirements.

## Features

- Commit graph of all local branches, remote-tracking branches, tags and HEAD,
  with branch, remote and tag badges above their commits. A branch and its
  upstream share one badge (`main │ origin`) when the upstream has the
  branch's name and is on the same commit; when they differ, both show, so
  unpushed work stands out. Another remote's branch of the same name keeps a
  badge of its own.
  The current branch and its upstream come first; badges that do not fit the row
  collapse into a `+N` badge.
- The commit you have checked out (HEAD) and the line of its first parents stay
  in the leftmost column, on a branch or detached, so your branch does not move
  sideways when another branch gets newer commits. Branches newer than HEAD
  run to its right, and one built on HEAD joins the column at HEAD. Under a
  branch filter that picks no branch or tag on HEAD's commit, columns go to
  the commits in the order they are listed.
- Stashes are rows of their own, directly above the commit each was made on,
  newest on top, with a square node beside that commit's line. A stash whose
  commit is no longer on its branch (after a rebase or amend) sits above the
  branch's tip and says so; an autostash git left behind shows in the warning
  color. Stashing or dropping updates the rows without reloading the history.
- Uncommitted changes are a row of their own above HEAD (and above the stashes
  on HEAD), with a dashed node and the counts of conflicts, staged, changed and
  untracked files. See [Uncommitted changes](#uncommitted-changes).
- Other worktrees of the repository: a branch checked out in another worktree
  names it inside its badge (`feature │ review`), with a lock when the worktree
  is locked and struck through when its folder is gone; a worktree on a
  detached HEAD has a badge of its own on that commit, and commits made there
  show in the graph too. The graph follows what the other worktrees do: their
  commits, switches, locks and removals.
- Commit details: author, committer, full message, parents and changed files.
- Click a changed file to open its diff in the VS Code diff editor; browse file
  after file without losing your place in the graph.
- Filter the graph to selected branches, remotes or tags, and switch to
  first-parent history. By default the graph shows all local and remote-tracking
  branches; tags label their commits, and a tag that is on no branch shows when
  you select it in the filter.
- Hide the badges of noisy refs, such as CI tags, without changing the history:
  glob rules per repository (`*-rc*`), with exceptions, that leave the commits
  and lines in place. Strata keeps the rules itself; nothing is written to the
  repository or its git config.
- Several repositories in one workspace: switch between them from the toolbar.
  Each keeps its own filters and selection, and the graph comes back on the
  repository you looked at last.
- The graph comes back after restarting VS Code, pinned if you pinned it, at the
  commit you had selected and with the same filters.
- Rows show the subject, then the author (long names are cut after about 16
  characters), the date (`11-15 07:35` this year, `2023-11-15` before) and the
  short hash; the row's tooltip has the author's full name and the full date.
- Works in narrow editors: while the subject has less than 60 characters of
  room the date gives way first, then the author; the short hash stays until
  the subject would have less than 30. Commit details unfold right under the
  commit instead of taking a side or bottom pane.
- Works in local folders, WSL, SSH and other remote workspaces: Strata runs
  where the repository is.
- Follows your color theme, including high contrast themes; graph colors adapt
  to the theme's background so lines stay readable.

## Using the graph

- Open the graph from:
  - the **Graph** item in the status bar, which shows the repository of the file
    you are editing (right-click the status bar to hide it);
  - the graph button on a repository in the Source Control view, or **Open in
    Commit Graph** on a row of its Repositories list, which show that
    repository;
  - **Strata: Show Commit Graph** in the Command Palette.

  The graph's tab is titled with the name of the repository it shows.

- With more than one repository open, click the repository name at the left of
  the toolbar to pick another one, or run **Strata: Switch Repository...**. The
  list is the one in the Source Control view, in the same order
  (`scm.repositories.sortOrder`), with each repository's current branch. The
  graph stays on the
  repository you picked until you pick another; when that repository is closed,
  it shows another one and says so in the status bar.
- Scroll to load more history.
- Click a commit to unfold its details under it; click it again, or press
  <kbd>Esc</kbd> in the list, to fold them. <kbd>Esc</kbd> inside the details
  takes you back to the list. With the list focused, ↑/↓ move the selection
  (open details follow it), <kbd>Home</kbd> and <kbd>End</kbd> go to the first
  commit and to the last one loaded so far, and <kbd>Enter</kbd> unfolds or
  folds.
- Changed files are listed as a folder tree; click a folder (or use ←/→) to fold
  it.
- Click a file in the details to open its diff against the parent commit. Hover
  a file (or focus it) for **Old**, the compare icon and **New**: the file as it
  was before the commit, the diff, and the file as of the commit. Added files
  only have **New** and deleted files only **Old**. <kbd>Alt</kbd> opens to the
  side. With a file focused, ↑/↓ move between files, <kbd>Enter</kbd> opens it,
  and <kbd>O</kbd>, <kbd>D</kbd>, <kbd>N</kbd> open the old version, the diff
  and the new version.
- Right-click a file for open and copy actions: **Copy Relative Path** (relative
  to the repository root), **Copy Path**, and for renamed files **Copy Old
  Relative Path**. <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> (<kbd>⌥⇧⌘C</kbd>
  on macOS) copies the relative path of the focused file. Right-click a commit
  to copy its hash, short hash, subject or patch.
- With the list focused, <kbd>Shift</kbd>+<kbd>F10</kbd> or the Menu key opens
  the selected commit's or stash's menu, <kbd>Ctrl</kbd>+<kbd>C</kbd> copies its
  full hash and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>C</kbd> its patch
  (<kbd>Cmd</kbd> on macOS); a stash's patch includes its untracked files. With
  text selected in the details, <kbd>Ctrl</kbd>+<kbd>C</kbd> copies that text.
- The details start with who and when: author, date and the short hash. Click
  the hash to copy the full hash; the arrow after it shows the full hash,
  author, committer and parents (with their subjects) and stays open for other
  commits until you close it.
- Below come the full subject and the message body, in the editor font. Wrapped
  paragraphs flow to the width of the view; code, lists and trailers keep their
  lines. Long bodies show their first lines and **Show more**. Web addresses
  (`http://` and `https://`) in the body are links that open in your browser.
- The changed files follow the message, with the commit they are compared with
  (click it to select that commit). In wide editors the message and the files
  sit side by side, and a tree that fits flows into columns.
- To compare two commits, select one, then right-click any other commit and
  choose **Compare with Selected**. The details open on the commit you
  right-clicked and list every file that differs from the one you had selected;
  the line above the files names that commit, and **Old**, the compare icon and
  **New** open the file as of that commit, the diff between the two, and the
  file as of this one. **Show Own Changes** on the same line goes back to the
  commit's own changes; so does selecting any other row. The menu entry is
  there only while exactly one commit is selected, and not on that commit.
- Use the branch button in the toolbar to show only some refs (type to search,
  **Show All** to reset), and **First parent** to follow only the main line of
  merges.
- To hide badges, click **Badges** in the toolbar (it says **N hidden** once
  some are) and type a pattern under **Hide badges matching**: `*` matches any
  text (slashes too), `?` one character, and the rest is compared exactly, case
  included, so a plain name hides just that ref. It says how many refs the
  pattern matches and lists them; **Hide** (or <kbd>Enter</kbd>) adds a rule,
  and **Show** adds an exception for refs it already hides. The eye beside each
  listed ref hides or shows just its badge; with nothing typed, the list shows
  the hidden badges. **Rules** lists the rules, the last matching one deciding;
  move or remove them there, or tick **Show hidden badges** to see every badge
  until you close the graph. A checked out branch's badge is never hidden: the
  current branch's, and one another worktree has checked out, which names that
  worktree.
- Right-click a branch, remote branch or tag badge for **Hide Badge**, or for
  **Hide Similar Badges...**, which opens the badge popover with a pattern for
  refs named like it (`release/2.1` gives `release/*`) to check before hiding.
- In the graph, rest the pointer on a commit's node for a card with all of its
  refs: a detached HEAD, branches (the current one marked), remote branches and
  tags, including those collapsed into `+N`. Badges a rule hides are dimmed and
  name the rule, for example _hidden by `*-rc*`_. Below them, for every commit:
  **On**, the branches and remote branches holding it (the current branch
  first); **First in**, the first tag that has it; **After**, the nearest tag
  before it and how many commits later it is. These leave out tags and
  branches a rule hides, and a line git cannot answer quickly (say, an old
  commit in a large repository without a commit-graph) is left out.
- The commit checked out has a bar at the left edge of its row (and a tinted
  row in dark themes). **HEAD**
  in the toolbar (or **Strata: Go to HEAD** in the Command Palette) selects it,
  loading more history if needed. When the branch filter leaves it out, Strata
  says so and offers to add the current branch to the filter (or to show all
  branches with HEAD detached).
- To find commits, click the magnifier in the toolbar, press
  <kbd>Ctrl</kbd>+<kbd>F</kbd> (<kbd>Cmd</kbd>+<kbd>F</kbd> on macOS) in the
  graph or run **Strata: Find Commit...**. Text selected in the details fills it
  in, so a hash in a message is one key away. Type:
  - plain text, found in commit messages (subject and body), ignoring case and
    taken literally (no patterns);
  - 4 to 40 hex digits, also read as a commit hash (or its start);
  - `author:ada` or `author:"Ada Lovelace"`, the author's name or email; with
    text too, a commit must match both.

  The search covers the history the graph shows (its branch filter and **First
  parent**). Matching text is marked in the rows, and the badges of branches
  and tags whose names match; a match that only has the text in its body is
  tinted. The widget counts the matches ("3 of 21", "+" while more may come; it
  stops at 10,000) and marks the selected one more strongly. <kbd>Enter</kbd>
  and <kbd>Shift</kbd>+<kbd>Enter</kbd>, or the arrows, go to the next and
  previous match from the selection. A match further down than the history
  loaded so far is found first, then the history loads down to it, with
  progress in the toolbar; <kbd>Esc</kbd> stops it, and <kbd>Esc</kbd> again
  closes the widget. The list button opens the matches as a list: the commit a
  hash names, the branches and tags whose names match, then the commits in graph
  order (**Show N more…** for the rest); click one to go to it. When an author's
  name has your text, the list offers to search `author:` for it.

  A commit the graph does not show, because the branch filter or **First
  parent** leaves it out or only a tag reaches it, gets **Not in view**, and a
  notification says why. When showing another branch or all parents would show
  it, the notification offers that (**Show feature Too**, **Show All
  Parents**). The search runs again when the graph reloads.

- With stashes in the repository, the toolbar counts them and how many are not
  in the graph (their commit is not loaded yet, filtered out, or on no branch).
  Click it for **Show Stashes**: pick one to select it and open its details,
  loading more history if needed. Click a stash row to see its message, the
  commit it was made on, how many files were staged, its changes (click a file
  for its diff) and its untracked files. **Show stash rows** in the branch
  button's menu hides or shows the rows.
- Use the refresh button after changing the repository outside VS Code.

## Uncommitted changes

When the work tree has changes, a row above HEAD says `Uncommitted changes` with
how many files have conflicts, are staged, are changed and are untracked, as the
Source Control view counts them (an untracked folder counts once). The row
follows the work tree as you edit, save and stage; while the graph is hidden
behind another editor it waits and catches up when you come back.

- Click it to unfold the files by group: Conflicts, Staged (HEAD against the
  index), Changes (the index against the file) and Untracked. Click a file to
  open it as Source Control would: a diff, the file itself, or Resolve Conflicts
  for a conflicted one; <kbd>Alt</kbd>+click opens it to the side.
- **Commit...** opens the Source Control view, where you write the message and
  commit. **Stash Changes...** and **Stash Changes (Include Untracked)...** stash
  them; the new stash shows as a row above HEAD. Right-click the row for the
  same commands.
- When HEAD is not in the graph (the branch filter leaves it out, or it is not
  loaded yet), the toolbar's **HEAD** button carries a dot; its tooltip counts
  the changes.
- In a file or folder history the row counts only changes to that path.
- `git.untrackedChanges` set to `hidden` leaves untracked files out. When
  counting them takes over a second (a huge folder git does not ignore), Strata
  stops counting them for the rest of the session and says so in the row's
  tooltip.

## File and folder history

The graph can show only the commits that change a file or a folder, with the
branches and lines around them:

- Right-click files or folders in the Explorer, or changes in the Source
  Control view, and choose **Show History in Commit Graph**. Several selected
  together make one history.
- Right-click an editor tab or inside an editor and choose **Show File History
  in Commit Graph**, or run **Strata: Show File History in Commit Graph** from
  the Command Palette for the file you are editing (also from a diff's tab).
- Right-click a changed file in a commit's details and choose **Show File
  History** or **Show Folder History** (its folder).

With several repositories open, the history comes from the innermost one
holding the file. Picking a repository's top folder shows its whole history.

While a history is shown:

- A chip in the toolbar names the file or folder. Click × on it, or **Show All
  Files** in its menu, to see the whole graph again. Its menu also shows the full
  path, how many commits change it, **Show History of** its folder, **Open File**
  and **Copy Relative Path**.
- The toolbar counts the commits that change the path. On large repositories
  rows appear as git finds them and the count says `Searching history of …`.
- Branch tips (and HEAD) that leave the path alone keep their rows, dimmed and in
  italics with `no change to <name>`, so their badges stay where the branches
  are. So do merges that only join other lines.
- The branch filter and **First parent** still apply. With **First parent** on,
  the history shows the merges that brought each change into the branch.
- For a single file, hover a row and click **Diff** to open what that commit
  changed in it, without opening the details. In the details, the file's row
  is marked and its folders unfolded.
- When the history starts where the file was renamed, a note under the last row
  says so; **Include \<old path\>** adds the old name to the history (the chip
  then says `+1`). In a partial clone only renames that kept the contents are
  found, so that no file contents are downloaded.
- A link in the details to a commit outside the history (a parent, the base)
  shows the whole graph again with that commit selected.
- Stashes are not shown as rows.

The history follows git's merge simplification (`--simplify-merges`): a merge
that took one side's version of the path is left out, and so is a change on a
branch that was merged away without it, unless a branch still points to it.

On a large repository the whole history of a rarely changed file takes as long
as reading all of history. **Strata: Write Commit-Graph for Faster History**
writes changed-path filters along with the commit-graph, which make file and
folder history several times faster; when a file's history is slow to search,
Strata offers to write them.

## Changing the repository

Right-click a commit, a branch, remote branch or tag badge, or a stash row for
what you can do with it; **Branch and Tag Actions...** in a commit's menu offers
the same for its badges from the keyboard. On the row of a commit one local
branch points at (besides the current one), Checkout, Merge and Rebase act on
that branch, so a merge commit names it, and **Checkout (Detached)** checks out
the commit; with several branches there, the row acts on the commit and you pick
a branch from its badge.

The graph tab's title bar has buttons for **Fetch From All Remotes**, and Pull
and Push (or **Publish Branch...** when the current branch has no upstream),
and for **Undo Last Operation** once there is one to undo; while an operation
is stopped, for Continue, Abort and Fetch. Its **...** menu has the stash
commands, **Show Stashes...**, Skip (while stopped) and **Show Git Output**.
The Command Palette has them too. While an operation runs, the toolbar and the
banner say which, and the other commands wait for it.

Changing the repository needs git 2.34 or later: with an older git these
commands are disabled, and a banner above the graph says so and names the git
it found.

- **Branches and tags:** Checkout (a remote branch checks out its local branch,
  or creates one that tracks it; when the local branch of that name tracks
  something else, you choose between switching to it anyway and creating a
  tracking branch of another name), Create Branch, Create Tag, Rename, Delete
  and Copy Name. Deleting a branch asks first only when no other branch or tag
  has its commits, and names them. Push Tag pushes a tag to a remote (you pick
  one when there are several), and says so when the remote already has a
  different tag of that name. Delete Remote Tag deletes it there and keeps your
  local tag; that can't be undone.
- **Worktrees:** right-click a worktree's name in a branch badge, or its own
  badge, to **Open Worktree in New Window** or **in Current Window**, **Reveal
  Worktree in File Explorer** (local windows only), **Copy Worktree Path**, or
  **Show Worktree in Graph** when this window has it open. **Remove
  Worktree...** says first what goes with it (its folder, its uncommitted
  changes, its lock); the branch stays. A worktree whose folder is gone offers
  **Prune Worktrees**. A branch another worktree has checked out has no
  Checkout, Rename or Delete in its menu; when one is refused anyway (from the
  keyboard, or the worktree appeared meanwhile), the notification names the
  worktree and offers to show or open it, or to prune it and try again.
- **History:** Merge into Current Branch (fast-forward or a merge commit),
  Rebase Current Branch onto This, Cherry Pick, Revert, and Reset Current Branch
  to Here in any of git's modes. When a merge can fast-forward, Fast-Forward
  is the first button of the confirmation, unless `merge.ff` is false: then
  Create Merge Commit is. Strata asks first only when there is a choice
  to make, when Undo couldn't bring back what is lost, or when commits already
  pushed would be rewritten; the confirmation says what happens to which
  commits. A merge commit can be cherry picked relative to the parent you
  choose, and reverted, which undoes the commits it brought in from its other
  parents.
- **Several commits at once:** Revert is also in the menu of a Shift-click
  selection (see below) and undoes all of its commits in one run of git,
  newest first, in one new commit each. Strata asks at most once, the result
  says how many commits there were, and Undo takes back the whole run in one
  step. A selection with a merge commit in it is refused: revert the merge on
  its own. When one of the commits conflicts, the run stops there with the
  rest still to do, and Continue, Skip and Abort work as for a single commit.
- **Tidying recent commits:** commits of the current branch's first-parent
  line, from HEAD down to the first merge, can be rewritten before you push
  them. A file or folder history shows only the commits that change it, so it
  offers none of this; clear the path filter first.
  - **Edit Message...** (also the pencil beside the subject in the details)
    turns the subject and body into a fixed-width field with a guide at column
    72 and the subject's length. <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (<kbd>⌘</kbd>
    on macOS) saves, <kbd>Esc</kbd> cancels; the draft stays while you look at
    other commits and after a restart, until HEAD moves.
  - Shift-click another commit of the line to select the run between the two.
    The panel under the oldest offers **Squash...**, **Drop...** and **Copy
    Hashes** (also in the rows' menu). Squash opens the editor with the oldest
    commit's message; append the others' from the list beside it. The result
    keeps the oldest commit's author and date.
  - **Fixup into Parent** melds a commit into the one below it, keeping that
    one's message. **Fixup into Older Commit...** lets you pick any older
    commit of the line. **Drop Commit...** removes a commit.
  - **Reorder Commits...** (also in the menu of the current branch's badge)
    turns the list into a draft of a new order. The commits of the line show a
    handle: drag a row to another place, or press <kbd>Alt</kbd>+<kbd>↑</kbd>
    or <kbd>Alt</kbd>+<kbd>↓</kbd> to move the selected commit, or a
    Shift-click run as one block. The same keys on a selected commit of the
    line start a draft too. A moved commit shows how far it went (`↑2`,
    `↓1`), and every commit that would get a new hash shows its hash struck
    through. Commits that swap places and change the same file are marked
    **May conflict**, and the banner above the list names a file; it also says
    when the draft rewrites commits a remote already has. Nothing changes
    until **Apply** in the banner (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>,
    <kbd>⌘</kbd> on macOS), which runs one interactive rebase. **Cancel** or
    <kbd>Esc</kbd> gives the draft up, as does HEAD moving, another operation
    starting or filtering by a path.
  - Editing a message, squashing a run and fixing up into the parent keep
    every commit in place, so Strata writes the new commits directly: your
    work tree, staged changes, stashes and file times are not touched, and
    nothing can conflict. Commits are signed when `commit.gpgSign` is set, and
    the repository's `commit-msg` hook (a Gerrit Change-Id, say) runs on the
    message you wrote. Fixing up into an older commit, dropping and reordering run an
    interactive rebase instead, with uncommitted changes stashed around it; if
    it stops at a conflict, continue or abort from the banner.
  - Strata asks first when a remote-tracking branch already has commits that
    would be rewritten, or when other refs are on them. Other local branches
    on a rewritten commit move along by default (the confirmation's first
    button); tags, branches checked out in another worktree and branches that
    only branched off stay on the old commits. Undo puts every moved branch
    back.
- **Stashes:** Stash Changes (optionally with untracked files), Apply, Pop,
  Drop, Create Branch from Stash and Copy Patch. Apply and Pop bring staged
  changes back staged, unless they no longer apply to the index or you have
  staged changes of your own. Apply, Pop and Create Branch from Stash change
  nothing when files the stash's untracked part adds already exist in your work
  tree, and name those files so you can move them away first.
- **Remotes:** Fetch From All Remotes (Fetch Remote on a remote branch badge
  fetches just its remote), Pull (fast-forward, merge or rebase, following
  `pull.rebase`), Push and Publish Branch. A fetch removes the badges of
  branches deleted on the remote when git's `fetch.prune` (or
  `remote.<name>.prune`) is set; Strata does not prune on its own.
  Pull on the badge of a branch that
  isn't checked out fast-forwards it to its upstream without switching to it; a
  branch that diverged stays as it is until you switch to it and pull, and one
  checked out in another worktree is pulled there. Set Upstream, on a branch badge,
  makes a remote branch you pick its upstream, same-named ones listed first.
  Pull and Push follow the branch's
  configured upstream, also one given by URL (as a fork's pull request checkout
  sets) or one a single-branch clone doesn't fetch. When the remote deleted the
  upstream, Pull says so and offers to publish the branch again or unset its
  upstream. A rejected push says how many commits the remote has that your
  branch doesn't, and offers Pull for the current branch (then Push again) and a
  force push with lease when `git.allowForcePush` is on. When it is off, the
  message names that setting and Open Settings takes you to it: a branch whose
  pushed commits you rewrote can only be force pushed. Delete Remote Branch,
  on a remote branch badge, says which commits no other branch or tag has and
  which local branches track it (they stay). It deletes nothing when someone
  pushed to the branch since your last fetch, and asks again with what they
  pushed. Deleting a remote branch can't be undone.
- **Uncommitted changes** stay in place, without a question, when git carries
  them over the operation: a switch, merge, pull, cherry pick or revert leaves
  changes to other files alone. When git can't (changes to files the operation
  changes, any change before a rebase, staged changes before a merge commit,
  cherry pick or revert), the confirmation names them and offers to stash them
  around the operation and bring them back after it. A switch also offers to let
  git merge them into the target; `strata.autoStash` set to `never` puts that
  first. A hard reset keeps your changes in a stash it never pops, unless you
  discard them. A keep reset over changes to files it changes moves just those
  changes into such a stash and keeps the rest in place.
- **Untracked files** in the way stop a checkout, merge, rebase, pull, cherry
  pick, revert or Create Branch from Stash that would put files of its own
  there. Strata names them and offers **Stash Them & Retry**, which moves just
  those files into a stash and runs the operation again. That stash stays in the
  list. Strata does not bring your files back, because the operation puts its
  own versions in their place.
- Merge says so when the two lines have no commit in common. In a **shallow
  clone**, which may only lack that commit, Merge and Rebase offer **Fetch More
  History** (100 commits further back) or **Fetch Full History** instead. Cherry
  Pick, Revert and Copy Patch (of a commit or of one of its files) offer the
  same for the clone's oldest commits, whose parents are not there to tell their
  changes from the whole tree. Run the operation again once the history is
  there.
- **Undo Last Operation** puts back what the last operation changed: a reset,
  merge, rebase, cherry pick or revert, an edited message, squash, fixup,
  drop or reorder (also one that stopped and that Continue
  or Skip finished), a created, renamed or deleted branch or tag, or a dropped
  stash. It only moves the branch the operation moved, and asks first if that
  branch moved since. Operations that change history or delete something also
  offer Undo in the notification that reports them; creating, renaming or
  checking out a branch or tag reports in the status bar only.
- When an operation stops at conflicts, Strata says where and in which files,
  and marks the commit it stopped at (and a rebase's target) in the graph;
  **Resolve...** opens them, **Skip...** (rebase, cherry pick and revert) leaves
  the stopped commit out, and other changes (except Fetch) are disabled until
  you continue or abort. A Continue that stops again (at the next conflict, or
  at an `edit` or `break` of a rebase you started with `git rebase -i`) says so.
  A cherry pick or revert of several commits that you ended with `git commit`
  instead of `git cherry-pick --continue` still shows as in progress, with
  Continue for the remaining commits and Abort. Strata never opens an editor for
  a commit message: before continuing a rebase whose remaining steps would
  (`reword`, `squash`, `fixup -c`, `merge` without `-C`), it offers to type
  `git rebase --continue` into a terminal for you, or to continue with the
  messages git prepares, unedited. If bringing back stashed changes conflicts,
  the stash is kept and Strata says where it is. Abort and Skip name the changes
  you made while the operation was stopped that git would throw away (any change
  during a rebase; staged ones during a merge, cherry pick or revert), and keep
  them in a stash it never pops, unless you discard them.
- Every git command Strata runs is logged in the **Strata** output channel
  (**Show Git Output**). Sign-in problems offer to type the same command into a
  terminal for you to run there.

## Large repositories

On the Linux kernel (1.5 million commits) the graph opens in about 0.2 seconds
once the repository has a commit-graph.

Strata asks git for history in topological or commit date order (the
`strata.commitOrder` setting), either of which is fast when the
repository has a commit-graph file. Without one, git reads the whole history
before showing the first commit (about 20 seconds on the Linux kernel). When
that happens Strata offers to write a commit-graph; you can also run **Strata:
Write Commit-Graph for Faster History** at any time. It runs
`git commit-graph write --reachable --changed-paths` and only adds a cache file
to the repository. The changed-path
filters make file and folder history faster; the offer after a slow first page
writes the commit-graph without them, which is quicker, and a slow file history
offers to add them. Turn the offer off with the
`strata.suggestCommitGraph` setting.

Finding commits reads the messages git stores, so it scans all history when few
commits match: about a second on a repository of 150,000 commits, with or
without a commit-graph. Common text shows its first matches at once with a
commit-graph; without one, git again reads all history first, so a search
that has found nothing after half a second offers to write one (once per
window, as for a slow first page). A bar runs along the bottom of the find
widget while it searches.

New commits (your own, fetched or rebased) are not in the commit-graph until it
is written again. With `strata.keepCommitGraphUpdated` turned on (or **Write and
Keep Updated** in the offer), Strata adds them in the background a few seconds
after the history changes, which takes milliseconds even on the Linux kernel. It
only updates repositories that already have a commit-graph.

## Settings

- `strata.suggestCommitGraph` (default: `true`): Offer to write a commit-graph
  file when a repository without one takes long to show its first page of
  history, and changed-path filters when the history of a file or folder takes
  long to search.
- `strata.autoStash` (default: `gitConfig`): Which choice comes first when a
  switch would overwrite uncommitted changes: gitConfig and always put stashing
  them first, never letting git merge them into the target. Operations ask about
  uncommitted changes only when git can't run over them: a rebase, a merge,
  pull, cherry pick or revert over changes to the files it changes, and a merge
  commit, cherry pick or revert over staged changes.
- `strata.columns` (default: all `true`): Which columns the commit rows may show
  beside the subject (`author`, `date`, `hash`); turn one off to hide it for
  good. A narrow graph also hides them on its own: the date and then the author
  while the subject has less than 60 characters of room, the hash only below 30.
- `strata.commitOrder` (default: `topological`): The order of the commit rows.
  `topological` keeps the commits of each branch together: the graph stays
  narrow, and a new commit can move the rows of its whole branch. `date` lists
  commits by commit date, newest first: a new commit moves no other row, and the
  graph is wider when branches advance side by side. A commit is always above
  its parents.
- `strata.keepCommitGraphUpdated` (default: `false`): When the history of a
  repository that has a commit-graph changes (commits, fetches, rebases, branch
  changes), add the new commits to the commit-graph in the background
  (`git commit-graph write --reachable --split`). Repositories without a
  commit-graph are left alone.
