Feature: A person connects SystemDox to Claude by signing in (ADR-229)
  A person adds a workspace's address to Claude, signs in on the console and
  approves. Claude holds a short token. The API key behind the connection stays
  with SystemDox. The contract is specs/changes/connect-mcp-by-sign-in/.

  Every scenario is @proposed until the pull request that builds it flips it
  to @built (ADR-201 §2.4).

  @proposed
  Scenario: MCS-M-01 Claude is told where to sign in
    Given a person who has not connected yet
    When Claude first calls the workspace's address
    Then it is refused
    And it is told where to read how to sign in

  @proposed
  Scenario: MCS-M-02 Claude reads how to sign in to this workspace
    Given the workspace's address
    When Claude asks how to sign in
    Then it learns that this host signs people in for this address
    And it learns that it must prove itself with a one-time challenge

  @proposed
  Scenario: MCS-M-03 Claude registers itself and nothing is stored
    Given Claude returning to its own callback address
    When it registers twice
    Then it is given the same client identity both times
    And nothing is written down

  @proposed
  Scenario: MCS-M-04 A client that would return somewhere we do not allow is refused
    Given a client returning to an address that is not allowed
    When it registers
    Then it is refused

  @proposed
  Scenario: MCS-M-05 A tampered client never sends a person away
    Given a client identity that was altered to return somewhere else
    When a browser arrives with it
    Then the person sees that the request cannot be trusted
    And the browser is not sent to that address

  @proposed
  Scenario: MCS-M-06 Signing in starts on the console
    Given a client that may connect
    When a browser arrives to sign in
    Then the request is kept for ten minutes
    And the browser goes to the console's approval page

  @proposed
  Scenario: MCS-M-07 An approved code gives Claude a short token and never the API key
    Given a person who approved a connection
    When Claude exchanges its code with the right proof
    Then it receives a token for one hour and a refresh token
    And the API key is nowhere in what it receives

  @proposed
  Scenario: MCS-M-08 A code works once
    Given a code that was exchanged over thirty seconds ago
    When it is exchanged again with the right proof
    Then it is refused
    And the connection it created has ended

  @proposed
  Scenario: MCS-M-09 A code without the right proof is refused
    Given a person who approved a connection
    When a code is exchanged with the wrong proof
    Then it is refused
    And the code still works for Claude

  @proposed
  Scenario: MCS-M-10 A code goes stale
    Given a code issued over a minute ago
    When Claude exchanges it
    Then it is refused

  @proposed
  Scenario: MCS-M-11 A connected Claude uses a tool
    Given a connected Claude
    When it asks for the workspace's checks
    Then it receives them
    And SystemDox called its own API with the connection's key

  @proposed
  Scenario: MCS-M-12 A read-only connection is not offered a write tool
    Given a connection approved as read only
    When Claude asks what it can do
    Then it sees the tools that read
    And it sees no tool that writes

  @proposed
  Scenario: MCS-M-13 A connection allowed to write is offered every tool
    Given a connection approved with writes
    When Claude asks what it can do
    Then it sees the tools that read and the tools that write

  @proposed
  Scenario: MCS-M-14 A token works only on its own workspace
    Given a token for one workspace
    When it is used on another workspace's address
    Then it is refused

  @proposed
  Scenario: MCS-M-15 A token that has run out is renewed
    Given a token over an hour old
    When Claude renews it with its refresh token
    Then it receives a new token and a new refresh token
    And the old token no longer works

  @proposed
  Scenario: MCS-M-16 Two renewals at the same moment both work
    Given a refresh token that was used a moment ago
    When Claude uses it again within thirty seconds
    Then it receives the same new tokens

  @proposed
  Scenario: MCS-M-17 An old refresh token ends the connection
    Given a refresh token that was replaced over thirty seconds ago
    When someone uses it
    Then it is refused
    And the connection has ended

  @proposed
  Scenario: MCS-M-18 Approving needs a recent second factor
    Given an owner whose second factor is not recent
    When they approve a connection
    Then they are asked to confirm it
    And no key is created

  @proposed
  Scenario: MCS-M-19 Only an owner or an admin can connect
    Given a member who is neither an owner nor an admin
    When they approve a connection
    Then they are told an owner or admin has to connect
    And no key is created

  @proposed
  Scenario: MCS-M-20 A person signed in to another workspace is told so
    Given an owner of two workspaces, active in the other one
    When they approve a connection to this one
    Then they are told they are in another workspace
    And no key is created

  @proposed
  Scenario: MCS-M-21 Approving again replaces the connection
    Given a person already connected from Claude's apps
    When they approve Claude's apps again
    Then the new connection works
    And the old key is revoked
    And they have one connection

  @proposed
  Scenario: MCS-M-22 Declining tells the client no
    Given a person looking at a request
    When they decline it
    Then the browser returns to the client with a refusal
    And no key is created

  @proposed
  Scenario: MCS-M-23 A revoked key ends the connection after it is confirmed
    Given a connection whose key was revoked in Settings
    When Claude keeps calling for over an hour
    Then the connection has ended
    And Claude is told to sign in again

  @proposed
  Scenario: MCS-M-24 A short outage does not end a connection
    Given the API refusing a connection's key for a few minutes
    When the API recovers and Claude calls again
    Then the tool works
    And the connection has not ended

  @proposed
  Scenario: MCS-M-25 A suspended person keeps their connection for when they return
    Given a person suspended from the workspace
    When Claude calls a tool
    Then Claude is told the access is suspended
    And the connection has not ended
    And it works again once the suspension is lifted

  @proposed
  Scenario: MCS-M-26 Other refusals are only a tool's answer
    Given a tool the API refuses for its own reasons
    When Claude calls it
    Then Claude sees the tool's error
    And the connection is untouched

  @proposed
  Scenario: MCS-M-27 A connection ends with its key
    Given a connection whose key has expired
    When Claude calls a tool or renews its token
    Then it is told to sign in again

  @proposed
  Scenario: MCS-M-28 These addresses answer only on an MCP host
    Given the API's own address
    When someone asks it how to sign in
    Then nothing is found

  @proposed
  Scenario: MCS-M-29 Nobody can learn which workspaces exist
    Given an address for a workspace that does not exist
    When someone asks how to sign in
    Then the answer looks the same as for a real workspace

  @proposed
  Scenario: MCS-M-30 A key in a configuration file works as before
    Given a key in a configuration file
    When a client calls the existing address
    Then it works as it did
    And a call with no key is refused as it was

  @proposed
  Scenario: MCS-M-31 Erasing a person ends their connections
    Given a person with a connection
    When the person is erased
    Then their connection and its tokens are gone

  @proposed
  Scenario: MCS-M-32 A retried code gets the same tokens
    Given a code exchanged a moment ago
    When Claude exchanges it again with the right proof within thirty seconds
    Then it receives the same tokens

  @proposed
  Scenario: MCS-M-33 A second computer keeps its own connection
    Given a person connected from Claude Code on one computer
    When they approve Claude Code on a second computer
    Then both computers stay connected
