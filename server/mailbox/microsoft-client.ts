export const CLIENT_ID = "";
export const TOKEN_ENDPOINT_RULING = "Q-E14 approved";

type MicrosoftAvailability =
  | { available: true; clientId: string }
  | { available: false; reason: "no_registration" | "endpoint_unruled" };

export class MicrosoftClientConfig {
  private readonly clientId: string;
  private readonly endpointRuling: string;

  constructor(clientId: string = CLIENT_ID, endpointRuling: string = TOKEN_ENDPOINT_RULING) {
    this.clientId = clientId;
    this.endpointRuling = endpointRuling;
  }

  read(): MicrosoftAvailability {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(this.clientId)) {
      return { available: false, reason: "no_registration" };
    }
    if (this.endpointRuling !== "Q-E14 approved") {
      return { available: false, reason: "endpoint_unruled" };
    }
    return { available: true, clientId: this.clientId };
  }
}
