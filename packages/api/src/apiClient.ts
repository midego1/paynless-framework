import { SupabaseClient, createClient } from '@supabase/supabase-js';
// Import types from @paynless/types
import type {
  // UserProfile, UserProfileUpdate, // Removed unused imports
  ApiResponse, ApiError as ApiErrorType,
  FetchOptions // Import FetchOptions from types
} from '@paynless/types';
// ---> Import AuthRequiredError from types <--- 
import { AuthRequiredError } from '@paynless/types'; 
import { StripeApiClient } from './stripe.api'; 
import { AiApiClient } from './ai.api';
import { NotificationApiClient } from './notifications.api'; // Import new client
import { OrganizationApiClient } from './organizations.api'; // <<< Import Org client
import { UserApiClient } from './users.api'; // +++ Add import
import { WalletApiClient } from './wallet.api'; // Corrected WalletApiClient import path
import { DialecticApiClient } from './dialectic.api'; // <<< IMPORT NEW DIALECTIC CLIENT
import { logger } from '@paynless/utils';
import type { Database } from '@paynless/db-types'; // Keep this for createClient

// Define ApiError class locally for throwing (can extend the type)
export class ApiError extends Error {
    public code?: string | number;
    constructor(message: string, code?: string | number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    }
}

// Helper type guard to check if an object looks like our standard ApiErrorType
function isApiErrorType(obj: unknown): obj is ApiErrorType {
  return (
    typeof obj === 'object' && 
    obj !== null &&
    ('code' in obj) && // Check for code property
    ('message' in obj) // Check for message property
    // We don't strictly need to check the types of code/message here for the guard,
    // but we assume they match ApiErrorType if the properties exist.
  );
}

// Config interface for the constructor
interface ApiClientConstructorOptions {
    supabase: SupabaseClient<Database>;
    supabaseUrl: string;
    supabaseAnonKey: string;
}

export class ApiClient {
    private supabase: SupabaseClient<Database>;
    private functionsUrl: string;
    private supabaseAnonKey: string; // <<< Add storage for anon key
    private tokenPromise: Promise<string | undefined> | null = null; // Add this line

    public billing: StripeApiClient;
    public ai: AiApiClient;
    public notifications: NotificationApiClient; // Add new client property
    public organizations: OrganizationApiClient; // <<< Add Org client property
    public users: UserApiClient; // +++ Add users property
    public wallet: WalletApiClient; // Added wallet property
    public dialectic: DialecticApiClient; // <<< ADD DIALECTIC CLIENT PROPERTY

    // Update constructor signature
    constructor(options: ApiClientConstructorOptions) {
        this.supabase = options.supabase;
        // Use the passed supabaseUrl to construct functionsUrl
        // Ensure it doesn't have a trailing slash before appending /functions/v1
        const baseUrl = options.supabaseUrl.replace(/\/$/, ''); 
        this.functionsUrl = `${baseUrl}/functions/v1`; 
        this.supabaseAnonKey = options.supabaseAnonKey; // <<< Store anon key
        logger.info('API Client constructed with Functions URL:', { url: this.functionsUrl });

        this.billing = new StripeApiClient(this);
        this.ai = new AiApiClient(this);
        this.notifications = new NotificationApiClient(this); // Initialize new client
        this.organizations = new OrganizationApiClient(this); // <<< Initialize Org client
        this.users = new UserApiClient(this); // +++ Initialize UserApiClient
        this.wallet = new WalletApiClient(this); // Initialize WalletApiClient
        this.dialectic = new DialecticApiClient(this); // <<< INITIALIZE DIALECTIC CLIENT
    }

    /**
     * Returns the base URL for Supabase Edge Functions used by this client.
     * @returns {string} The functions base URL.
     */
    public getFunctionsUrl(): string {
        return this.functionsUrl;
    }

    /**
     * Returns the base URL for Supabase Edge Functions used by this client.
     * @returns {string} The functions base URL.
     */
    public getBaseUrl(): string {
        return this.functionsUrl;
    }

    private async getToken(): Promise<string | undefined> {
        logger.debug('[ApiClient.getToken] Attempting to get session...');

        if (this.tokenPromise) {
            logger.debug('[ApiClient.getToken] Token fetch already in progress, returning existing promise.');
            return this.tokenPromise;
        }

        logger.debug('[ApiClient.getToken] No token fetch in progress, initiating new one.');
        this.tokenPromise = (async () => {
            try {
                const { data, error } = await this.supabase.auth.getSession();
                logger.debug('[ApiClient.getToken] this.supabase.auth.getSession() returned.', { error: !!error, hasData: !!data });
                if (error) {
                    logger.error('Error fetching session for token:', { error });
                    return undefined;
                }
                logger.debug('[ApiClient.getToken] Fetched session data:', { session: data.session });
                return data.session?.access_token;
            } finally {
                // Important: Clear the promise so subsequent calls can fetch a new token if needed (e.g., after expiry)
                // Or if the previous one failed.
                logger.debug('[ApiClient.getToken] Clearing in-flight tokenPromise.');
                this.tokenPromise = null;
            }
        })();

        return this.tokenPromise;
    }

    // Update request method to use ApiResponse and ApiErrorType from @paynless/types
    private async request<T>(endpoint: string, options: FetchOptions = {}): Promise<ApiResponse<T>> {
        const url = `${this.functionsUrl}/${endpoint.startsWith('/') ? endpoint.substring(1) : endpoint}`;
        const headers = new Headers(options.headers || {});
        let processedBody = options.body; // Assume body is passed as-is initially

        // 1. Handle FormData:
        if (options.body instanceof FormData) {
            // If the body is FormData, let the browser set the Content-Type.
            // Remove any Content-Type erroneously set by the caller for FormData to prevent conflicts.
            if (headers.has('Content-Type')) {
                logger.warn("[apiClient] Content-Type header was removed because body is FormData. Browser will set appropriate Content-Type.");
                headers.delete('Content-Type');
            }
            // `processedBody` remains `options.body` (the FormData instance).
        } else if (options.body !== undefined && options.body !== null) {
            // 2. Handle non-FormData bodies:
            const contentType = headers.get('Content-Type');

            // Check if it's a "plain" JS object (not a Blob, ArrayBuffer, File, etc.)
            const isPlainObject = typeof options.body === 'object' &&
                                  !(options.body instanceof Blob) &&
                                  !(options.body instanceof ArrayBuffer) &&
                                  !(options.body instanceof URLSearchParams) &&
                                  // Add other Fetch API body types if necessary
                                  Object.prototype.toString.call(options.body) === '[object Object]';

            if (!contentType && isPlainObject) {
                // Case 2a: No Content-Type from caller, and body is a plain object.
                // Default to application/json and stringify.
                headers.set('Content-Type', 'application/json');
                // For the condition below, we need the updated Content-Type if it was just set.
                // So, we re-fetch it if it was initially null and then set.
                const currentContentType = headers.get('Content-Type'); 
                if (currentContentType && currentContentType.toLowerCase().includes('application/json') && isPlainObject) {
                    processedBody = JSON.stringify(options.body);
                }
            } else if (contentType && contentType.toLowerCase().includes('application/json') && isPlainObject) {
                // Case 2b: Caller set Content-Type to application/json (or similar), and body is a plain object.
                processedBody = JSON.stringify(options.body);
            }
            // Case 2c: Else (body is already a string, Blob, ArrayBuffer, URLSearchParams,
            // or it's an object but Content-Type is not JSON, or no Content-Type and not a plain object).
            // In these cases, `processedBody` remains `options.body`, and `headers` remain as set by the caller.
        }

        headers.append('apikey', this.supabaseAnonKey);

        // Only add Authorization if not already present in options.headers and not public
        if (!options.isPublic && !headers.has('Authorization')) {
            const effectiveToken = options.token; // Use options.token if provided directly
            if (effectiveToken) {
                logger.debug('[ApiClient.request] Using token from options.');
                headers.append('Authorization', `Bearer ${effectiveToken}`);
            } else {
                logger.debug('[ApiClient.request] No token in options, attempting to call this.getToken().');
                const tokenFromAuthGetSession = await this.getToken();
                logger.debug('[ApiClient.request] this.getToken() returned.', { hasToken: !!tokenFromAuthGetSession });
                if (tokenFromAuthGetSession) {
                    headers.append('Authorization', `Bearer ${tokenFromAuthGetSession}`);
                }
            }
        }
        
        // ---> Log headers right before fetch (Revised) <--- 
        const headersObject: Record<string, string> = {};
        headers.forEach((value, key) => { headersObject[key] = value; });
        logger.info(`[apiClient] Requesting ${options.method || 'GET'} ${url}`, { headers: headersObject });

        try {
            const response = await fetch(url, {
                ...options,
                headers: headers,
                body: processedBody
            });
            
            // ---> Log right after fetch, before parsing body <--- 
            logger.info('[apiClient] Fetch completed', { status: response.status, ok: response.ok, url: response.url });
            
            // ---> Log content-type and wrap parsing in try/catch <--- 
            const contentType = response.headers.get('Content-Type');
            logger.info('[apiClient] Response Content-Type:', { contentType });
            
            let responseData: unknown;

            // --- BEGIN MODIFICATION ---
            // Handle 204 No Content: Body should be empty, do not parse
            if (response.status === 204) {
                responseData = null; // Or undefined, or a specific marker object
                logger.info('[apiClient] Received 204 No Content. Skipping body parsing.');
            } else {
            // --- END MODIFICATION ---
                try {
                    responseData = contentType?.includes('application/json') 
                                        ? await response.json() 
                                        : await response.text(); 
                } catch (parseError: unknown) {
                     logger.error('[apiClient] Failed to parse response body:', { error: (parseError as Error)?.message ?? String(parseError) });
                     // Use the imported ApiErrorType structure for consistency when throwing
                     const errorPayload: ApiErrorType = {
                        code: String(response.status), // Use status as code if parsing failed
                        message: (parseError as Error)?.message ?? 'Failed to parse response body'
                     };
                    throw new ApiError(errorPayload.message, errorPayload.code);
                }
            // --- ADDED closing brace for the new else block ---
            }
            // --- END ADDED closing brace ---

            // ---> Add specific debug log for 401 response data (using WARN level) <--- 
            if (response.status === 401) {
                logger.warn('[apiClient] Raw responseData for 401 status:', { responseData });
            }

            // ---> Handle AUTH_REQUIRED error <---
            // Use the refined type guard
            if (response.status === 401 && !options.isPublic && isApiErrorType(responseData) && responseData.code === 'AUTH_REQUIRED') {
                logger.warn('[apiClient] Received 401 with AUTH_REQUIRED code. Throwing AuthRequiredError...');
                const errorMessage = responseData.message ?? 'Authentication required'; // Message property is now safely accessed
                throw new AuthRequiredError(errorMessage);
            }

            // ---> Check for other non-OK responses <---
            if (!response.ok) {
                 logger.warn(`[apiClient] Received non-OK (${response.status}) response body:`, { responseData });

                let errorPayload: ApiErrorType;
                // Use the refined type guard before accessing properties
                if (isApiErrorType(responseData)) {
                     // Now we know it has code and message, matching ApiErrorType
                     errorPayload = responseData;
                } else if (typeof responseData === 'object' && responseData !== null && 'error' in responseData && typeof responseData.error === 'string') {
                     // Handle simple { error: string } responses
                     errorPayload = { code: String(response.status), message: responseData.error };
                } else {
                    // Handle other cases (e.g., plain text response)
                    const errorMessage = typeof responseData === 'string' && responseData.trim() !== ''
                                        ? responseData
                                        : response.statusText || 'Unknown API Error';
                    errorPayload = { code: String(response.status), message: errorMessage };
                }
                logger.error(`API Error ${response.status} on ${endpoint}: ${errorPayload.message}`, { code: errorPayload.code, details: errorPayload.details });
                return { status: response.status, error: errorPayload };
            }

            // Success case
            return { status: response.status, data: responseData as T };

        } catch (error: unknown) {
             // ---> Check if it's the specific AuthRequiredError we threw <---
            if (error instanceof AuthRequiredError) {
                logger.warn("AuthRequiredError caught by API Client. Re-throwing for store handler...");
                // The logic to save pending actions has been moved to the relevant store (e.g., aiStore).
                // We simply re-throw the error here so the caller can handle it.
                throw error;
            }

            // ---> Otherwise, handle as a network/unexpected error <---
            // Check if error is an instance of Error before accessing .message
            const errorMessage = error instanceof Error ? error.message : 'Network error';
            logger.error(`Network or fetch error on ${endpoint}:`, { error: errorMessage });
            return {
                status: 0, // Indicate network/fetch error with status 0 or similar
                error: { code: 'NETWORK_ERROR', message: errorMessage }
            };
        }
    }

    // Update public methods to reflect the new ApiResponse structure
    public async get<T>(endpoint: string, options?: FetchOptions): Promise<ApiResponse<T>> {
        return this.request<T>(endpoint, { ...options, method: 'GET' });
    }

    public async post<T, U>(endpoint: string, body: U, options?: FetchOptions): Promise<ApiResponse<T>> {
        return this.request<T>(endpoint, { ...options, method: 'POST', body: body as BodyInit | null | undefined });
    }

    public async put<T, U>(endpoint: string, body: U, options?: FetchOptions): Promise<ApiResponse<T>> {
        return this.request<T>(endpoint, { ...options, method: 'PUT', body: body as BodyInit | null | undefined });
    }

    public async patch<T, U>(endpoint: string, body: U, options?: FetchOptions): Promise<ApiResponse<T>> {
        return this.request<T>(endpoint, { ...options, method: 'PATCH', body: body as BodyInit | null | undefined });
    }

    public async delete<T>(endpoint: string, options?: FetchOptions): Promise<ApiResponse<T>> {
        return this.request<T>(endpoint, { ...options, method: 'DELETE' });
    }

    /**
     * Retrieves the underlying Supabase client instance.
     * **Warning:** This should ONLY be used for setting up the onAuthStateChange listener
     * at the application root. Do NOT use this to bypass the ApiClient for other operations.
     * @returns The SupabaseClient instance.
     */
    public getSupabaseClient(): SupabaseClient<Database> {
        return this.supabase;
    }
}

// --- Singleton Instance Logic --- 
let apiClientInstance: ApiClient | null = null;

// Config interface for the initializer
interface ApiInitializerConfig {
    supabaseUrl: string;
    supabaseAnonKey: string;
}

// Update initializeApiClient signature and implementation
export function initializeApiClient(config: ApiInitializerConfig) {

    //console.log('initializeApiClientinitializeApiClientinitializeApiClientinitializeApiClientinitializeApiClientinitializeApiClient')
  if (apiClientInstance) {
    throw new Error('ApiClient already initialized');
  }
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
     throw new Error('Supabase URL and Anon Key are required to initialize ApiClient');
  }
  // Create Supabase client inside the initializer
  const supabase = createClient<Database>(config.supabaseUrl, config.supabaseAnonKey);
  
  // Pass both client and URL to constructor
  apiClientInstance = new ApiClient({ 
      supabase: supabase, 
      supabaseUrl: config.supabaseUrl,
      supabaseAnonKey: config.supabaseAnonKey
  });
  logger.info('ApiClient Singleton Initialized.');
}

export function _resetApiClient() {
  apiClientInstance = null;
  logger.info('ApiClient Singleton reset for testing.');
}

// ---> Export for testing purposes <--- 
export function getApiClient(): ApiClient {
    if (!apiClientInstance) {
        throw new Error('ApiClient not initialized. Call initializeApiClient first.');
    }
    return apiClientInstance;
}

// Export the api object, update methods to match new ApiResponse
export const api = {
    get: <T>(endpoint: string, options?: FetchOptions): Promise<ApiResponse<T>> => 
        getApiClient().get<T>(endpoint, options),
    post: <T, U>(endpoint: string, body: U, options?: FetchOptions): Promise<ApiResponse<T>> => 
        getApiClient().post<T, U>(endpoint, body, options),
    put: <T, U>(endpoint: string, body: U, options?: FetchOptions): Promise<ApiResponse<T>> => 
        getApiClient().put<T, U>(endpoint, body, options),
    patch: <T, U>(endpoint: string, body: U, options?: FetchOptions): Promise<ApiResponse<T>> => 
        getApiClient().patch<T, U>(endpoint, body, options),
    delete: <T>(endpoint: string, options?: FetchOptions): Promise<ApiResponse<T>> => 
        getApiClient().delete<T>(endpoint, options),
    ai: () => getApiClient().ai, 
    billing: () => getApiClient().billing,
    notifications: () => getApiClient().notifications,
    organizations: () => getApiClient().organizations,
    users: () => getApiClient().users,
    wallet: () => getApiClient().wallet, // Added wallet accessor
    dialectic: () => getApiClient().dialectic, // Added dialectic accessor
    getSupabaseClient: (): SupabaseClient<Database> => 
        getApiClient().getSupabaseClient(),
}; 