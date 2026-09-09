import type { GenerationProvider } from "../ports.js";
import type {
  ProviderGenerationRequest,
  ProviderResultSnapshot,
  ProviderSubmission,
} from "../types.js";

/** A zero-cost adapter for provider-contract tests; it never performs I/O. */
export class FakeGenerationProvider implements GenerationProvider {
  readonly submitted: ProviderGenerationRequest[] = [];
  readonly queried: Array<{ providerTaskId: string; model?: string }> = [];

  constructor(
    private readonly behavior: {
      submit?: (request: ProviderGenerationRequest) => ProviderSubmission | Promise<ProviderSubmission>;
      query?: (providerTaskId: string) => ProviderResultSnapshot | Promise<ProviderResultSnapshot>;
    } = {},
  ) {}

  async submit(request: ProviderGenerationRequest): Promise<ProviderSubmission> {
    this.submitted.push(structuredClone(request));
    if (this.behavior.submit) return this.behavior.submit(request);
    throw new Error("FakeGenerationProvider.submit behavior is required");
  }

  async query(
    providerTaskId: string,
    request?: Pick<ProviderGenerationRequest, "model">,
  ): Promise<ProviderResultSnapshot> {
    this.queried.push({ providerTaskId, model: request?.model });
    if (this.behavior.query) return this.behavior.query(providerTaskId);
    throw new Error("FakeGenerationProvider.query behavior is required");
  }
}
