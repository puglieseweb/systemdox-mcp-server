Feature: Project rules are edited and deleted over MCP
  An agent that finds a project rule out of date changes or removes it itself,
  instead of asking a person to open the console. The contract is
  specs/changes/edit-project-rules-over-mcp/contract.md.

  Every scenario is @proposed until the pull request that builds it flips it
  to @built (ADR-201 §2.4).

  @built
  Scenario: RUL-M-01 An agent sees each rule with its id
    Given the workspace has a rule "All deployments go through GitHub Actions"
    When an agent lists the project rules
    Then each rule is shown with its id

  @built
  Scenario: RUL-M-02 An agent changes a rule's words
    Given the workspace has a rule "All deployments go through GitHub Actions"
    When an agent gives that rule new words by its id
    Then the rule says the new words the next time any session reads the rules
    And it keeps its id and its category

  @built
  Scenario: RUL-M-03 An agent moves a rule to another category
    Given the workspace has a testing rule
    When an agent moves that rule to the process category by its id
    Then the rule is listed under process, with the same words

  @built
  Scenario: RUL-M-04 An agent deletes a rule
    Given the workspace has a rule that no longer holds
    When an agent deletes that rule by its id
    Then no session sees that rule any more

  @built
  Scenario: RUL-M-05 A rule the workspace does not have is refused
    When an agent changes or deletes a rule the workspace does not have
    Then it is told there is no such rule in this workspace
    And no rule changes

  @built
  Scenario: RUL-M-06 A change with nothing to change is refused before anything is sent
    When an agent asks to change a rule but gives neither new words nor a category
    Then it is told to give new words or a category
    And nothing is sent to SystemDox
