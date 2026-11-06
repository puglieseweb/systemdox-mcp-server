Feature: Skills published and installed over MCP and from a terminal (ADR-216)
  The local server runs on the user's computer and reads and writes the skill
  folder itself, so the model never retypes a file. The hosted server cannot
  see a disk, so the agent passes and writes the files. The install-skill
  command is what the console's Install button copies.

  Scenario: SKL-M-01 Publishing from this computer reads the folder byte for byte
    Given a skill folder with SKILL.md, a reference, a script, a .git folder and an old manifest
    When publish_skill is called with the folder
    Then SystemDox receives the three skill files exactly as they are on disk
    And nothing from .git and no manifest is sent

  Scenario: SKL-M-02 A binary file stops the publish before anything is sent
    Given a skill folder that holds a PNG image
    When publish_skill is called with the folder
    Then the publish is refused naming the image
    And nothing is sent to SystemDox

  Scenario: SKL-M-03 Installing writes the latest version into the personal skills folder with a manifest
    When install_skill is called for "landing-review"
    Then the files are in ~/.claude/skills/landing-review exactly as published
    And .systemdox-skill.json records the version and every file's hash

  Scenario: SKL-M-04 An edited file stops the install until overwrite is asked for
    Given "landing-review" version 1 is installed and its SKILL.md was edited here
    When version 2 is installed
    Then nothing is written and the refusal names SKILL.md
    When version 2 is installed with overwrite
    Then SKILL.md is version 2's

  Scenario: SKL-M-05 A new version removes what it no longer ships and keeps what someone added
    Given "landing-review" version 1 is installed and a notes file was added here
    When version 2, which drops the script, is installed
    Then the script is removed
    And the added notes file is still there

  Scenario: SKL-M-06 The hosted server never reads or writes a disk
    When the hosted server lists its publish_skill and install_skill inputs
    Then publish_skill takes files but no folder
    And install_skill returns the files and the manifest for the agent to write

  Scenario: SKL-M-07 The install-skill command installs with no agent and exits 2 on local edits
    When "install-skill landing-review --target <dir>" runs
    Then it exits 0 and the skill is in the folder
    When a file there is edited and the command runs again
    Then it exits 2 and names the file

  Scenario: SKL-M-08 Without a key the command says how to set one and never prompts
    When "install-skill landing-review" runs with no SYSTEMDOX_API_KEY
    Then it exits 1 and says to set SYSTEMDOX_API_KEY

  Scenario: SKL-M-09 A path that climbs out of the skill folder is never written
    When a version naming "../outside.md" is installed
    Then the install is refused and nothing is written outside the folder

  Scenario: SKL-M-10 An install never writes through a link
    Given the skill folder holds a link to a folder outside it
    When "landing-review" is installed into it
    Then the install is refused naming the link
    And nothing is written outside the folder

  Scenario: SKL-M-11 An install goes only into a folder named after the skill
    When install_skill is asked to install "landing-review" into ".git/hooks"
    Then the install is refused and nothing is written

  Scenario: SKL-M-12 Publishing leaves hidden files and links out
    Given a skill folder that also holds a .env file
    When publish_skill is called with the folder
    Then the .env file is not sent and the result says it was left out
    And a folder holding a link is refused before anything is sent

  Scenario: SKL-M-13 Publishing can carry a change note and the version the files were edited from
    Given a skill folder with SKILL.md, a reference, a script, a .git folder and an old manifest
    When publish_skill is called with the folder, the note "Fix the GA4 step" and base version 3
    Then SystemDox receives the note and base version 3 with the files
    And a publish without them sends neither
