export interface PingPongExampleService {
  ping(what: string): Promise<string>
}