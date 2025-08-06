# Fix Adapter Factory

The ai_service adapters do not have a common contract with the factory for how they are built and used. The factory will be refactored to use a single fixed contract for adapter construction and operation. The test suites will be completely aligned to ensure all adapters interactions with the app are abstract and identical.  

This document provides a complete, verified, and end-to-end refactoring to ensure that the ai_service establishes a fixed contract between the factory and adapters and all adapters pass the same suite of tests.

## Legend

*   `[ ]` 1. Unstarted work step. Each work step will be uniquely named for easy reference. We begin with 1.
    *   `[ ]` 1.a. Work steps will be nested as shown. Substeps use characters, as is typical with legal documents.
        *   `[ ]` 1. a. i. Nesting can be as deep as logically required, using roman numerals, according to standard legal document numbering processes.
*   `[✅]` Represents a completed step or nested set.
*   `[🚧]` Represents an incomplete or partially completed step or nested set.
*   `[⏸️]` Represents a paused step where a discovery has been made that requires backtracking or further clarification.
*   `[❓]` Represents an uncertainty that must be resolved before continuing.
*   `[🚫]` Represents a blocked, halted, or stopped step or has an unresolved problem or prior dependency to resolve before continuing.

## Component Types and Labels

The implementation plan uses the following labels to categorize work steps:

*   `[DB]` Database Schema Change (Migration)
*   `[RLS]` Row-Level Security Policy
*   `[BE]` Backend Logic (Edge Function / RLS / Helpers / Seed Data)
*   `[API]` API Client Library (`@paynless/api` - includes interface definition in `interface.ts`, implementation in `adapter.ts`, and mocks in `mocks.ts`)
*   `[STORE]` State Management (`@paynless/store` - includes interface definition, actions, reducers/slices, selectors, and mocks)
*   `[UI]` Frontend Component (e.g., in `apps/web`, following component structure rules)
*   `[CLI]` Command Line Interface component/feature
*   `[IDE]` IDE Plugin component/feature
*   `[TEST-UNIT]` Unit Test Implementation/Update
*   `[TEST-INT]` Integration Test Implementation/Update (API-Backend, Store-Component, RLS)
*   `[TEST-E2E]` End-to-End Test Implementation/Update
*   `[DOCS]` Documentation Update (READMEs, API docs, user guides)
*   `[REFACTOR]` Code Refactoring Step
*   `[PROMPT]` System Prompt Engineering/Management
*   `[CONFIG]` Configuration changes (e.g., environment variables, service configurations)
*   `[COMMIT]` Checkpoint for Git Commit (aligns with "feat:", "test:", "fix:", "docs:", "refactor:" conventions)
*   `[DEPLOY]` Checkpoint for Deployment consideration after a major phase or feature set is complete and tested.

---

## Phase 1: Establish a Unified Adapter Contract

*   `[✅]` 1. **[REFACTOR]** Solidify the Adapter Interface Contract.
    *   `[✅]` 1.a. **[BE]** In `supabase/functions/_shared/types.ts`, update the `AiProviderAdapter` interface. Remove the `apiKey` parameter from the `sendMessage` and `listModels` method signatures. The `apiKey` will become a constructor-only dependency.
    *   `[✅]` 1.b. **[BE]** In `supabase/functions/_shared/types.ts`, create a new `AiAdapterOptions` interface to define the standard constructor arguments for all adapters.
        ```typescript
        export type AiProviderAdapter = new (
        apiKey: string,
        logger: ILogger,
        modelConfig: AiModelExtendedConfig
        ) => {
        sendMessage(
            request: ChatApiRequest,
            modelIdentifier: string, // The specific API identifier for the model (e.g., 'gpt-4o')
        ): Promise<AdapterResponsePayload>;

        listModels(): Promise<ProviderModelInfo[]>;
        };
        ```

## Phase 2: Refactor Factory and Adapters to Adhere to the Contract

*   `[✅]` 2. **[REFACTOR]** Refactor the AI Provider Factory.
    *   `[✅]` 2.a. **[BE]** In `supabase/functions/_shared/ai_service/factory.ts`, rewrite the `getAiProviderAdapter` function to use a provider-to-class map, making it generic and easily extensible.
    *   `[✅]` 2.b. **[BE]** Ensure the factory creates and passes the `AiAdapterOptions` object, including the `providerDbConfig`, to the constructor of the selected adapter class.

*   `[✅]` 3. **[REFACTOR]** Refactor all AI Provider Adapters.
    *   `[✅]` 3.a. **OpenAI Adapter**
        *   `[✅]` 3.a.i. **[BE]** In `openai_adapter.ts`, update the constructor to accept a single `options: AiAdapterOptions` argument.
        *   `[✅]` 3.a.ii. **[BE]** Refactor internal logic to use `this.modelConfig` for all configuration needs (e.g., token limits).
        *   `[✅]` 3.a.iii. **[BE]** Update method signatures to match the revised `AiProviderAdapter` interface.
    *   `[✅]` 3.b. **Anthropic Adapter**
        *   `[✅]` 3.b.i. **[BE]** In `anthropic_adapter.ts`, update the constructor to accept a single `options: AiAdapterOptions` argument.
        *   `[✅]` 3.b.ii. **[BE]** Refactor internal logic to use `this.modelConfig`.
        *   `[✅]` 3.b.iii. **[BE]** Update method signatures.
    *   `[✅]` 3.c. **Google Adapter**
        *   `[✅]` 3.c.i. **[BE]** In `google_adapter.ts`, update the constructor to accept a single `options: AiAdapterOptions` argument.
        *   `[✅]` 3.c.ii. **[BE]** Refactor internal logic to use `this.modelConfig`.
        *   `[✅]` 3.c.iii. **[BE]** Update method signatures.
    *   `[✅]` 3.d. **Dummy Adapter**
        *   `[✅]` 3.d.i. **[BE]** In `dummy_adapter.ts`, update the constructor to accept `options: AiAdapterOptions`.
        *   `[✅]` 3.d.ii. **[BE]** Update method signatures.

## Phase 3: Unify and Standardize Test Suites

*   `[✅]` 4. **[TEST-UNIT]** Create a Shared Adapter Test Suite.
    *   `[✅]` 4.a. **[BE]** Create a new file `supabase/functions/_shared/ai_service/adapter_test_contract.ts`.
    *   `[✅]` 4.b. **[BE]** In this file, implement a generic testing function. Its signature will be `testAdapterContract(adapterClass: AiProviderAdapterClass, mockProviderApi: MockApi, providerModelConfig: AiModelExtendedConfig)`. It will accept a provider-specific model configuration to ensure that it tests the adapter using a realistic tokenization strategy, not a generic or non-functional one. This function will run a standardized suite of Deno tests against any adapter that adheres to the contract.
    *   `[✅]` 4.c. **[BE]** The contract tests will include:
        *   Successful instantiation with valid `AiAdapterOptions`.
        *   **Message Construction & Tokenization:**
            *   `sendMessage` correctly combines message history and the new user message into the final payload.
            *   `sendMessage` correctly handles provider-specific message structuring (e.g., system prompts, alternating roles).
            *   `sendMessage` prevents message duplication when the same content exists in history and the new message.
            *   `sendMessage` respects the `max_tokens_to_generate` property from the `ChatApiRequest`, passing it to the provider.
            *   `sendMessage` throws a critical error if the token count of the final, constructed prompt payload (including all message history, system prompts, and the current user message) exceeds the `context_window_tokens` or `provider_max_input_tokens` from `modelConfig`. It does NOT truncate content.
        *   **Response Handling & Error States:**
            *   `sendMessage` success case (happy path), returning a valid `AdapterResponsePayload`.
            *   `sendMessage` handling of API errors (4xx, 5xx) and returning a standardized error.
            *   `sendMessage` handling of empty or invalid provider responses.
            *   `sendMessage` correctly maps provider-specific `finish_reason` (e.g., `max_tokens`, `stop_sequence`) to our standard reasons (`'length'`, `'stop'`).
            *   `sendMessage` respects `hard_cap_output_tokens` from `modelConfig` (if applicable at the adapter level).
        *   **Model Listing:**
            *   `listModels` success case, returning a valid `ProviderModelInfo[]`.
            *   `listModels` handling of API errors.

*   `[✅]` 5. **[TEST-UNIT]** Refactor Existing Adapter Tests.
    *   `[✅]` 5.a. **OpenAI Tests**
        *   `[✅]` 5.a.i. **[TEST-UNIT]** In `openai_adapter.test.ts`, remove all tests now covered by the shared contract.
        *   `[✅]` 5.a.ii. **[TEST-UNIT]** Import and use `testAdapterContract`, providing a mocked OpenAI API implementation.
        *   `[✅]` 5.a.iii. **[TEST-UNIT]** Retain only tests specific to OpenAI's unique payload formatting.
    *   `[✅]` 5.b. **Anthropic Tests**
        *   `[✅]` 5.b.i. **[TEST-UNIT]** In `anthropic_adapter.test.ts`, remove tests covered by the shared contract.
        *   `[✅]` 5.b.ii. **[TEST-UNIT]** Use `testAdapterContract` with a mocked Anthropic API.
        *   `[✅]` 5.b.iii. **[TEST-UNIT]** Retain tests for Anthropic-specific logic (e.g., alternating role filtering).
    *   `[✅]` 5.c. **Google Tests**
        *   `[✅]` 5.c.i. **[TEST-UNIT]** In `google_adapter.test.ts`, remove tests covered by the shared contract.
        *   `[✅]` 5.c.ii. **[TEST-UNIT]** Use `testAdapterContract` with a mocked Google API (`fetch`).
        *   `[✅]` 5.c.iii. **[TEST-UNIT]** Retain tests for Google-specific logic (e.g., system prompt prepending, `getModelDetails`).
    *   `[✅]` 5.d. **Dummy Adapter Tests**
        *   `[✅]` 5.d.i. **[BE]** First, refactor the `DummyAdapter` itself. It must import and use the application's shared `countTokensForMessages` utility to calculate its `token_usage` based on the echoed message content. It must not hardcode token values or use a bespoke counting method.
        *   `[✅]` 5.d.ii. **[TEST-UNIT]** In `dummy_adapter.test.ts`, refactor the test to use the `testAdapterContract`.
        *   `[✅]` 5.d.iii. **[TEST-UNIT]** The test **must not** mock the global `fetch` function, as the `DummyAdapter` does not perform external communication.
        *   `[✅]` 5.d.iv. **[TEST-UNIT]** The `MockApi` implementation for the dummy test will be a simple pass-through that instantiates the real `DummyAdapter` and calls its methods directly.
        *   `[✅]` 5.d.v. **[TEST-UNIT]** Add a separate, specific test case within `dummy_adapter.test.ts` to verify its unique tokenization behavior. This test will call `sendMessage` and then independently use `countTokensForMessages` to assert that the token counts returned by the adapter are correct.

## Phase 4: Documentation and Finalization

*   `[✅]` 6. **[DOCS]** Update Documentation.
    *   `[✅]` 6.a. **[DOCS]** Update `supabase/functions/_shared/ai_service/README.md` to reflect the new, unified factory and adapter contract. Detail the new process for adding a provider.

*   `[✅]` 7. **[COMMIT]** Final Commit.
    *   `[✅]` 7.a. Commit all changes with the message `feat: unify AI adapter factory and contracts`.
