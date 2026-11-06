Feature: The MCP server tells every session what its team uses and what this computer lacks (ADR-223)
  Installing the SystemDox MCP server should be enough. When a session connects,
  the server hands it a short text: the team's skills and when to use each, and
  what this computer still lacks. A skill installs itself, because installing
  one writes files and runs nothing. What runs by itself waits for the person.
  When something is wrong the server still connects, and says what to do.

  Every scenario is @proposed until the pull request that builds it flips it
  to @built (ADR-201 §2.4). The contract is specs/archive/session-brief/.

  @built
  Scenario: SES-M-01 A session that connects is told what the workspace's team setup holds
    Given the workspace has one team skill
    When a session connects
    Then it is told the words the workspace's team setup holds, without calling any tool

  @built
  Scenario: SES-M-02 A computer that lacks a team skill is told to install it before its first answer
    Given the workspace has one team skill, which is not on this computer
    When a session connects
    Then it is told the skill is missing and to install it before its first answer
    And it is told to tell the person what was installed
    And nothing has been written to this computer

  @built
  Scenario: SES-M-03 A computer with an older version of a team skill is told to update it, and to leave an edited one alone
    Given this computer has version 1 of a team skill whose latest version is 3
    When a session connects
    Then it is told the skill is behind, with both versions
    And it is told that if the update refuses because files were edited, it tells the person and leaves them

  @built
  Scenario: SES-M-04 A computer with the latest version is told nothing about it
    Given this computer has the latest version of a team skill
    When a session connects
    Then it is not asked to do anything about the skill

  @built
  Scenario: SES-M-05 A folder that did not come from SystemDox is named and left alone
    Given this computer has a folder named after a team skill that SystemDox did not write
    When a session connects
    Then it is told that folder is left alone, and is not asked to install over it

  @built
  Scenario: SES-M-06 With the current team plugin installed, the skills it carries are not asked for again
    Given the latest team plugin is installed on this computer and carries a team skill that is not in the skills folder
    When a session connects
    Then it is not asked to install the skill

  @built
  Scenario: SES-M-07 What only the person can install is offered with the first install, not in every session
    Given the team has published hooks, and this computer lacks a team skill
    When a session connects
    Then it is told to mention the setup command when it tells the person what it installed
    But when this computer lacks no team skill, it is not told to mention it

  @built
  Scenario: SES-M-08 The whole text stays under what a session will read
    Given the workspace has a hundred team skills, none of them on this computer
    When a session connects
    Then the text it is told is no longer than the limit
    And it says how many more are missing and where they are listed

  @built
  Scenario: SES-M-09 A computer with no key still connects, and says what to do
    Given this computer has no SystemDox key
    When a session connects
    Then it connects and lists its tools
    And it is told this computer has no key and the one command to run

  @built
  Scenario: SES-M-10 A refused key still connects, and says what to do
    Given the workspace refuses this computer's key
    When a session connects
    Then it is told the key was refused and where a new one comes from

  @built
  Scenario: SES-M-11 A slow or absent SystemDox does not hold a session's start
    Given SystemDox does not answer
    When a session connects
    Then it connects within the limit
    And it is told the team's skills were not checked and how to check again

  @built
  Scenario: SES-M-12 The hosted server cannot see a disk, says how to check, and reads the team setup only when a session connects
    Given the workspace has one team skill
    When a session connects to the hosted server
    Then it is told how to check this computer for itself
    But a request that is not a session connecting does not read the team setup

  @built
  Scenario: SES-M-13 Asking the server answers for this computer in full
    Given this computer lacks one team skill and has an older version of another, and the team has published hooks
    When an agent asks what the team setup holds
    Then the answer lists both skills, every hook command, and what this computer lacks
    And on the hosted server the answer says how to check instead, and names nothing about a disk it cannot see

  @built
  Scenario: SES-M-14 An older team plugin does not count as carrying a skill added since
    Given an older team plugin is installed on this computer, and a team skill added since is not in the skills folder
    When a session connects
    Then it is told the skill is missing
    And asking the server says the plugin installed is older than the latest

  @built
  Scenario: SES-M-15 A session is told to follow a new skill only when its line matches the request
    Given the workspace has one team skill, which is not on this computer
    When a session connects
    Then it is told to read the skill only when its line matches the request and it is not loaded yet

  @built
  Scenario: SES-M-16 What this computer lacks is never cut mid-sentence, even when the team's text is at its limit
    Given the team's text is at its limit, and this computer lacks many skills, has others behind, and others not from SystemDox
    When a session connects
    Then the text it is told is no longer than the limit
    And every sentence about what to do is whole

  @built
  Scenario: SES-M-17 The reason a computer has no key stays short and names no path
    Given this computer's stored keys name sixty workspaces and no choice between them, or cannot be read at all
    When a session connects
    Then it is told what to do in a short sentence, with no path to a file on this computer

  @built
  Scenario: SES-M-18 Asking for context with no working key says so, instead of saying nothing was found
    Given every read from SystemDox is refused
    When an agent asks for context
    Then it is told the read failed, not that nothing was found

  @built
  Scenario: SES-M-19 A skill held back for the person is named when asked, and never offered to install
    Given the team setup holds one skill back for the person
    When a session connects
    Then it is not asked to install the skill
    And asking the server names it as waiting for the person, and says the setup command brings it

  @built
  Scenario: SES-M-20 Asking the server names no skill the member may not read, and a hook command cannot forge its answer
    Given the team setup lists a skill this member may not read, and a hook command with line breaks
    When an agent asks what the team setup holds
    Then the unreadable skill is not named
    And the hook command stays on one line

  @built
  Scenario: SES-M-21 An answer that makes no sense still connects
    Given SystemDox answers something that is not a team setup
    When a session connects
    Then it is told the team's skills were not checked

  @built
  Scenario: SES-M-22 A skill folder that is really a plugin is refused when it is installed
    Given a skill published before such folders were refused, holding a plugin manifest
    When it is installed
    Then nothing is written, and the install says why

  @built
  Scenario: SES-M-23 A session installs the version that was checked, not whatever is latest by then
    Given the workspace has one team skill at version 4, which is not on this computer
    When a session connects
    Then it is told to install that skill at version 4

  @built
  Scenario: SES-M-24 Asking for context when some reads failed does not read as an all-clear
    Given most reads from SystemDox fail and the rest find nothing
    When an agent asks for context
    Then it is told how many reads failed, not just that nothing was found


  @built
  Scenario: SES-M-25 An installed skill does not send the person to restart
    Given a team skill that is not on this computer
    When a session installs it
    Then it is told no restart is needed
    And it is told to read the skill's SKILL.md if this session does not list the skill yet
    And the hosted server, which writes no files itself, says the same

  @built
  Scenario: SES-M-26 Setup makes the skills folder, so a new computer's first session can watch it
    Given a computer with no skills folder
    When the person adds the server with setup
    Then the skills folder exists, with nothing in it
