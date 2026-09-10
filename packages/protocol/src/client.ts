import { Context, Effect, Layer } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { RpcClient, RpcSerialization } from 'effect/unstable/rpc';
import { PipesRpcs } from './pipes';

export function requireSupportedBun(version = Bun.version) {
  if (!Bun.semver?.satisfies(version, '>=1.4.2')) {
    throw new Error(`pipes requires Bun 1.4.2 or newer; found ${version}. Run bun upgrade.`);
  }
}

export interface Connection {
  directory: string;
  port: number;
  token: string;
  url: string;
}

const makeClient = RpcClient.make(PipesRpcs);
export class Client extends Context.Service<Client, Effect.Success<typeof makeClient>>()(
  'pipes/Client',
) {
  static layer = (connection: Connection) =>
    Layer.effect(Client, makeClient).pipe(
      Layer.provide(
        RpcClient.layerProtocolHttp({
          transformClient: (client) =>
            HttpClient.mapRequest(
              client,
              HttpClientRequest.setHeader('Authorization', `Bearer ${connection.token}`),
            ),
          url: `${connection.url}/rpc`,
        }),
      ),
      Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
    );
}
