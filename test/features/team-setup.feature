Feature: Setting up a computer, and syncing its memory, from a terminal and over MCP (ADR-217, Amendments 1 and 2)
  One command sets a computer up with the team's plugin, instructions and
  memory, after the member has read what it will add. A team memory is synced
  file by file and never loses anyone's text. A person named in it becomes an
  identifier only after the member answers for each value and agrees to the
  change. An agent never answers for a person.

  Every scenario is @proposed until the pull request that builds it flips it
  to @built (ADR-201 §2.4). TSU-M-30 to TSU-M-32 are proved on a member's own
  computer against preprod, as ADR-217 Amendment 1 asks. Each run is recorded
  in test/evidence/team-setup/<id>.md, and the scenario is bound to that record
  (proposal item 20).

  # setup

  @built
  Scenario: TSU-M-01 Setup shows everything it will add, and changes nothing until the member says yes
    Given the workspace "acme" has published hooks, instructions and a team memory
    When the member runs setup and answers no
    Then they were shown every hook command, every MCP server, the import line, the memory folder and its file count
    And no file on the computer changed

  @built
  Scenario: TSU-M-02 Setup refuses an old Claude Code and says how to update
    Given Claude Code 2.1.201 is installed
    When the member runs setup
    Then it says Claude Code 2.1.316 or later is needed and how to update
    And no file on the computer changed

  @built
  Scenario: TSU-M-03 Setup adds the marketplace, the instructions and the memory folder, then names the two steps left
    When the member runs setup and answers yes
    Then the marketplace "systemdox-acme" is in their user settings
    And their CLAUDE.md imports the team instructions between SystemDox's markers
    And the checkout's local settings point auto memory at the team memory folder
    And they are told to open Claude Code once and then install "acme-setup" themselves

  @built
  Scenario: TSU-M-04 Setup never overwrites team instructions the member edited, unless asked
    Given the member edited the installed team instructions
    When the member runs setup for a new version of them
    Then it stops and names the edited file
    When the member runs setup again with overwrite
    Then the instructions are the new version

  @built
  Scenario: TSU-M-05 Without a person at the terminal, setup goes no further than what was accepted before
    Given the hooks changed since the member last accepted them
    When setup runs with --yes and no terminal
    Then it stops and lists the hooks as needing a person

  @built
  Scenario: TSU-M-06 The key is never written into a settings file, a plugin entry or a command line
    When the member runs setup and answers yes
    Then the key is only in SystemDox's own credentials file, readable by the member alone

  # marketplace-auth and plugin-path

  @built
  Scenario: TSU-M-07 The key is sent only to SystemDox, and only for the member's own workspace
    When Claude Code asks for the marketplace header of another host
    Then no key is given
    When Claude Code asks for the marketplace header of "acme" on SystemDox
    Then the member's key for "acme" is given

  @built
  Scenario: TSU-M-08 A plugin version already on the computer is served without going online
    Given version 3 of the team plugin is unpacked and its fingerprint recorded
    When Claude Code asks for version 3 at the start of a session
    Then its folder is given with no network call

  @built
  Scenario: TSU-M-09 A plugin download whose fingerprint differs is thrown away
    When version 4 is downloaded and its SHA-256 is not the one Claude Code named
    Then nothing is unpacked and the mismatch is reported

  @built
  Scenario: TSU-M-10 A plugin entry that climbs out, is a link, or is too big stops the unpack
    When version 4 holds an entry at "../../.bashrc"
    Then nothing is unpacked and the entry is named

  # Syncing a team memory

  @built
  Scenario: TSU-M-11 A file changed only here goes up, and one changed only by the team comes down
    Given the member changed "a.md" and the team changed "b.md" since the last sync
    When the member syncs
    Then the team has the member's "a.md"
    And the member has the team's "b.md"

  @built
  Scenario: TSU-M-12 A file changed on both sides keeps both texts
    Given the member and the team both changed "a.md" differently
    When the member syncs
    Then "a.md" holds the team's text
    And the member's text is beside it as "a.local-<today>.md"
    And both are listed

  @built
  Scenario: TSU-M-13 A file the team deleted, and the member did not touch, is deleted here
    Given the team deleted "old.md" and the member did not change it
    When the member syncs
    Then "old.md" is gone here too

  @built
  Scenario: TSU-M-14 The index merges line by line, keyed by the file each line links to
    Given the team added a line for "new.md" and the member added a line for "mine.md" under the same heading
    When the member syncs
    Then MEMORY.md has both lines under that heading
    And no conflict copy of MEMORY.md is made

  @built
  Scenario: TSU-M-15 Two members syncing at once lose nothing
    Given another member pushed while this member was merging
    When the member's push is refused as made on an old version
    Then the sync pulls, merges again and pushes once more
    And both members' files are in the team memory

  @built
  Scenario: TSU-M-16 A memory about one person, or a file kept back, is never sent and never touched
    Given a "user" memory and a file marked "share: false"
    When the member syncs
    Then neither was sent
    And neither was changed

  @built
  Scenario: TSU-M-17 A conflict copy stays on the member's computer
    Given "a.local-2026-11-01.md" is in the memory folder
    When the member syncs
    Then it was not sent

  @built
  Scenario: TSU-M-18 The first sync of a computer with two copies of a project keeps every difference
    Given the D: copy and the C: copy hold "x.md" with different text
    When the member syncs the D: copy importing the C: copy
    Then "x.md" holds one text and the other is beside it as a conflict copy
    And the C: copy is unchanged

  # People in a memory (Amendment 2)

  @built
  Scenario: TSU-M-19 Each value is asked about once, however many files hold it
    Given "07700 900456" is in 5 files and nobody has answered for it
    When the member syncs in a terminal
    Then they are asked about "07700 900456" once, shown in how many files and on which first line

  @built
  Scenario: TSU-M-20 A value another member answered is not asked about again
    Given another member answered "07700 900456" as the reseller contact "con_A"
    When the member syncs in a terminal
    Then they are not asked about "07700 900456"
    And the change to "`con_A` (reseller, sales)" is in the diff they are shown

  @built
  Scenario: TSU-M-21 After the member agrees to the diff, every file names the person by identifier
    Given the member filed "07700 900456" as someone else labelled "reseller, sales"
    When they agree to the diff
    Then every file that held "07700 900456" holds "`con_A` (reseller, sales)" instead
    And "07700 900456" is nowhere in the memory folder
    And no copy of the old text was kept

  @built
  Scenario: TSU-M-22 Saying no to the diff changes nothing, and those files wait
    Given values were answered during the sync
    When the member says no to the diff
    Then no file changed
    And the files holding those values were not sent and are listed

  @built
  Scenario: TSU-M-23 Leaving a value out keeps back every file that holds it
    When the member answers "leave these files out" for "07700 900456"
    Then every file holding it is marked "share: false"
    And none of them was sent

  @built
  Scenario: TSU-M-24 The organisation's own line stays as written
    When the member answers "ours, not a person" for "020 7946 0321"
    Then the files holding it are sent with "020 7946 0321" as written

  @built
  Scenario: TSU-M-25 A home-folder path becomes ~ as part of the same diff
    Given a file names "C:\Users\jbloggs\git\notes"
    When the member agrees to the diff
    Then the file names "~\git\notes"

  @built
  Scenario: TSU-M-26 Without a person at the terminal, nothing is asked and nothing is rewritten
    Given "07700 900456" is answered but still written in 2 files
    When the sync runs from an agent with no terminal
    Then nothing was asked and no file changed
    And the 2 files are listed as waiting, with the command for the member to run

  @built
  Scenario: TSU-M-27 When the vault does not answer, the files with unfiled values wait and the rest syncs
    Given Contacts does not answer
    When the member files "07700 900456" during a sync
    Then the files holding it were not sent and are listed
    And every other file was synced

  @built
  Scenario: TSU-M-28 A dry run asks nothing, files nobody and writes nothing
    When the member syncs with --dry-run
    Then they see how many values are still to answer, by kind and without the values
    And nothing was asked, filed, written or sent

  @built
  Scenario: TSU-M-29 resolve_person gives the details for this session only
    When an agent resolves "con_A" with resolve_person
    Then it is given the label, the name, the number and the address the vault holds
    And it is told the details are for this session and the memory must name the identifier
    And nothing was written to the computer

  # Proved on a member's own computer against preprod (ADR-217 Amendment 1),
  # each bound to its record in test/evidence/team-setup/

  @proposed
  Scenario: TSU-M-30 A member's acceptance of the plugin command survives an update of Claude Code
    Given the member accepted the command of team plugin version 3
    When Claude Code updates itself
    Then the next session loads version 3 without asking again

  @proposed
  Scenario: TSU-M-31 The acceptance prompt reads the same in a terminal that is not PowerShell
    When the member installs the team plugin from Git Bash
    Then they are shown the exact command and asked to accept it

  @proposed
  Scenario: TSU-M-32 The checkout's local settings move auto memory into the team memory folder
    Given setup pointed auto memory at the team memory folder for one checkout
    When a session in that checkout saves a memory
    Then the file is in the team memory folder

  # Tools and the detector

  @built
  Scenario: TSU-M-33 publish_setup_part reads only what the part accepts
    Given a hooks folder that also holds a link and a notes file
    When publish_setup_part is called for hooks with that folder
    Then the link stops the publish before anything is sent

  @built
  Scenario: TSU-M-34 The client finds exactly what the shared examples say a person's details are
    When the client's detector reads every example in person-values.json
    Then it finds each value listed as found, of its kind and in its normalised form
    And it finds nothing in the examples listed as not found
    And it finds the key prefix as a secret

  @built
  Scenario: TSU-M-35 A first sync into an empty folder brings the team memory down and deletes nothing
    Given a project the team has synced before and a member whose folder for it is empty
    When the member syncs for the first time
    Then the member has every file of the team's latest version
    And the team's latest version still has every file
    And the member's next sync is against that version
