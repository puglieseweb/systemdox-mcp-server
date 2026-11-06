Feature: An agent reads a change over MCP (ADR-218)
  A build session checks, before it writes code, that the brief of the story's
  change is passed and that the story's scenarios exist and are still proposed.
  The same server lists a repository's change folders beside the app's own
  specs, and the planning context names what waits for the owner.

  Every scenario is @proposed until the pull request that builds it flips it
  to @built (ADR-201 §2.4). The contract is specs/changes/change-page/.

  @built
  Scenario: CHG-M-01 get_change returns the four parts with their state, the files and the scenarios with their tags
    Given the change "customer-reminders" of "acme/booking-api" has its decision, contract and behaviour passed and no plan yet
    When get_change is called for "acme/booking-api" and "customer-reminders"
    Then the answer gives each of the four parts with its state
    And it lists the contract files by path and every scenario with its id and its tag

  @built
  Scenario: CHG-M-02 A build session learns which part still waits before it writes code
    Given the contract part of "customer-reminders" is waiting for review
    When get_change is called for "acme/booking-api" and "customer-reminders"
    Then the answer says the brief is not passed and names the contract part as the one that waits

  @built
  Scenario: CHG-M-03 A change that does not exist is not found
    When get_change is called for "acme/booking-api" and "nothing-here"
    Then the answer says there is no such change

  @proposed
  Scenario: CHG-M-04 get_specs lists the change folders beside the app's own specs
    Given "acme/booking-api" holds two change folders and the workspace has one spec written in the app
    When get_specs is called with no filter
    Then the three are listed, each change with its repository, its slug and the state of its brief

  @proposed
  Scenario: CHG-M-05 get_planning_context names every spec and lists the changes waiting for your review
    Given the workspace has a spec named "Customer reminders" and one change with a part waiting for your review
    When get_planning_context is called
    Then the spec is listed by its name, not as an empty line
    And the change is listed under "Changes waiting for your review" with the part that waits
