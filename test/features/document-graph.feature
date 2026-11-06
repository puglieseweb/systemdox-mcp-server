Feature: An agent can walk the graph over MCP (ADR-224)
  A coding agent asks what a document links to, how two documents connect, and
  how fresh the graph is. Each answer says how every link is known.

  Every scenario is @proposed until the pull request that builds it flips it
  to @built (ADR-201 §2.4). The contract is specs/changes/document-graph/.

  @built
  Scenario: GRF-M-01 An agent reads what a document links to, and how each link is known
    Given a document with a link known for a fact and a reference that could mean two decisions
    When an agent asks what the document links to
    Then it sees the link with how it is known and the file and line it came from
    And it sees the reference listed as ambiguous, with both candidates

  @built
  Scenario: GRF-M-02 An agent traces how two documents connect, and how far to trust it
    Given two documents joined through an inferred link
    When an agent asks how they connect
    Then it sees each step
    And it is told the path is only as strong as its weakest step

  @built
  Scenario: GRF-M-03 An agent sees which repositories are behind
    Given one repository up to date and one behind
    When an agent asks for the state of the graph
    Then it sees the links counted by how they are known
    And the repository that is behind is marked as behind

  @built
  Scenario: GRF-M-04 An answer that was cut says so
    Given a document with more links than the agent asked for
    When an agent asks what the document links to
    Then it is told how many it is seeing, how many exist, and how to see more
