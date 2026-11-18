// Producer owner: sc-safety (fixture transport). Consumer owner: new3-g2 (comms scenarios).
// Observations and submissions retain the exact product protocol. No alias,
// private request identifier, authority or reply is synthesized by this fixture.
export class CommsWireFixture {
  observe<T>(wire: T): T { return wire; }
  request<T>(body: T): T { return body; }
}
