export type ProviderId = "telegram" | "slack" | "kakao";
export type ProviderConfiguration = Readonly<Record<string, unknown>>;

export interface ConnectionUI {
  choose(title: string, choices: readonly { id: string; label: string }[]): Promise<string>;
  secret(title: string): Promise<string>;
  report(message: string): void;
  open(url: string): void;
}

export interface ConnectionDriver {
  readonly id: ProviderId;
  readonly label: string;
  connect(): Promise<ProviderConfiguration>;
}

/** Provider-specific branching belongs to drivers, never to this registry. */
export class ConnectionRegistry {
  private readonly drivers = new Map<ProviderId, ConnectionDriver>();
  constructor(drivers: readonly ConnectionDriver[]) {
    for (const driver of drivers) {
      if (this.drivers.has(driver.id)) throw new Error("duplicate connection driver");
      this.drivers.set(driver.id, driver);
    }
  }
  choices() { return [...this.drivers.values()].map(({ id, label }) => ({ id, label })); }
  connect(id: string): Promise<ProviderConfiguration> {
    const driver = this.drivers.get(id as ProviderId);
    if (!driver) throw new Error("unknown connection provider");
    return driver.connect();
  }
}
