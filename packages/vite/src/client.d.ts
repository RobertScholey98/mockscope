declare module 'virtual:mockscope' {
  /** Answers requests from the switched-on `.mockscope` mocks; falls through otherwise. Put it first in your handlers. */
  export const mockscopeHandler: import('msw').HttpHandler
}
