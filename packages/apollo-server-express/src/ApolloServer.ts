import express from 'express';
import corsMiddleware from 'cors';
import { json, OptionsJson } from 'body-parser';
import {
  renderPlaygroundPage,
  RenderPageOptions as PlaygroundRenderPageOptions,
} from '@apollographql/graphql-playground-html';
import {
  GraphQLOptions,
  ApolloServerBase,
  ContextFunction,
  Context,
  Config,
} from 'apollo-server-core';
import accepts from 'accepts';
import { graphqlExpress } from './expressApollo';

export { GraphQLOptions } from 'apollo-server-core';

export interface GetMiddlewareOptions {
  path?: string;
  cors?: corsMiddleware.CorsOptions | corsMiddleware.CorsOptionsDelegate | boolean;
  bodyParserConfig?: OptionsJson | boolean;
  onHealthCheck?: (req: express.Request) => Promise<any>;
  disableHealthCheck?: boolean;
}

export interface ServerRegistration extends GetMiddlewareOptions {
  app: express.Application;
}

export interface ExpressContext {
  req: express.Request;
  res: express.Response;
}

export interface ApolloServerExpressConfig extends Config {
  context?: ContextFunction<ExpressContext, Context> | Context;
}

export class ApolloServer extends ApolloServerBase {
  constructor(config: ApolloServerExpressConfig) {
    super(config);
  }

  // This translates the arguments from the middleware into graphQL options It
  // provides typings for the integration specific behavior, ideally this would
  // be propagated with a generic to the super class
  async createGraphQLServerOptions(
    req: express.Request,
    res: express.Response,
  ): Promise<GraphQLOptions> {
    return super.graphQLServerOptions({ req, res });
  }

  public applyMiddleware({ app, ...rest }: ServerRegistration) {
    app.use(this.getMiddleware(rest));
  }

  // TODO: While `express` is not Promise-aware, this should become `async` in
  // a major release in order to align the API with other integrations (e.g.
  // Hapi) which must be `async`.
  public getMiddleware({
    path,
    cors,
    bodyParserConfig,
    disableHealthCheck,
    onHealthCheck,
  }: GetMiddlewareOptions = {}): express.Router {
    if (!path) path = '/graphql';

    // In case the user didn't bother to call and await the `start` method, we
    // kick it off in the background (with any errors getting logged
    // and also rethrown from graphQLServerOptions during later requests).
    this.ensureStarting();

    const router = express.Router();

    if (!disableHealthCheck) {
      router.use('/.well-known/apollo/server-health', (req, res) => {
        // Response follows https://tools.ietf.org/html/draft-inadarei-api-health-check-01
        res.type('application/health+json');

        if (onHealthCheck) {
          onHealthCheck(req)
            .then(() => {
              res.json({ status: 'pass' });
            })
            .catch(() => {
              res.status(503).json({ status: 'fail' });
            });
        } else {
          res.json({ status: 'pass' });
        }
      });
    }

    // XXX multiple paths?
    this.graphqlPath = path;

    // Note that we don't just pass all of these handlers to a single app.use call
    // for 'connect' compatibility.
    if (cors === true) {
      router.use(path, corsMiddleware<corsMiddleware.CorsRequest>());
    } else if (cors !== false) {
      router.use(path, corsMiddleware(cors));
    }

    if (bodyParserConfig === true) {
      router.use(path, json());
    } else if (bodyParserConfig !== false) {
      router.use(path, json(bodyParserConfig));
    }

    // Note: if you enable playground in production and expect to be able to see your
    // schema, you'll need to manually specify `introspection: true` in the
    // ApolloServer constructor; by default, the introspection query is only
    // enabled in dev.
    router.use(path, (req, res, next) => {
      if (this.playgroundOptions && req.method === 'GET') {
        // perform more expensive content-type check only if necessary
        // XXX We could potentially move this logic into the GuiOptions lambda,
        // but I don't think it needs any overriding
        const accept = accepts(req);
        const types = accept.types() as string[];
        const prefersHTML =
          types.find(
            (x: string) => x === 'text/html' || x === 'application/json',
          ) === 'text/html';

        if (prefersHTML) {
          const playgroundRenderPageOptions: PlaygroundRenderPageOptions = {
            endpoint: req.originalUrl,
            ...this.playgroundOptions,
          };
          res.setHeader('Content-Type', 'text/html');
          const playground = renderPlaygroundPage(playgroundRenderPageOptions);
          res.write(playground);
          res.end();
          return;
        }
      }

      return graphqlExpress(() => this.createGraphQLServerOptions(req, res))(
        req,
        res,
        next,
      );
    });

    return router;
  }
}
