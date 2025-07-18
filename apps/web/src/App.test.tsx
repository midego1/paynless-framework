import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Remove MemoryRouter import, App provides its own RouterProvider
// import { MemoryRouter } from 'react-router-dom'; 
import App from './App';
import * as PaynlessStore from '@paynless/store';
import type { SubscriptionStore, WalletStore } from '@paynless/store'; // Import SubscriptionStore and WalletStore
// Import initialWalletStateValues and necessary selectors
import { initialWalletStateValues } from '@paynless/store';
import { mockSetAuthIsLoading, mockSetAuthUser, mockSetAuthSession, mockedUseAuthStoreHookLogic, resetAuthStoreMock } from './mocks/authStore.mock';

// --- Mocks ---

// Mock child components rendered by AppContent
// vi.mock('../../components/layout/Header', () => ({ Header: () => <div data-testid="site-header">Mocked Header Content</div> })); // Ensure real header renders
// vi.mock('../../components/layout/Footer', () => ({ Footer: () => <div data-testid="site-footer">Mocked Footer Content</div> })); // Ensure real footer renders
vi.mock('../../components/integrations/ChatwootIntegration', () => ({ ChatwootIntegration: () => <div data-testid="mock-chatwoot">Mocked Chatwoot</div> }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => <div data-testid="mock-toaster">Mock Toaster</div> }));

// --- Test Suite ---

describe('App Component', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        resetAuthStoreMock();

        // Reset global mocks
        vi.stubGlobal('matchMedia', vi.fn().mockImplementation(query => ({ 
            matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
        })));
        
        // Keep subscription store mock simple for now (if needed)
        const mockSubscriptionState: SubscriptionStore = {
            userSubscription: null,
            availablePlans: [],
            isSubscriptionLoading: false,
            hasActiveSubscription: false,
            isTestMode: false,
            error: null,
            setUserSubscription: vi.fn(),
            setAvailablePlans: vi.fn(),
            setIsLoading: vi.fn(),
            setTestMode: vi.fn(),
            setError: vi.fn(),
            loadSubscriptionData: vi.fn().mockResolvedValue(undefined),
            refreshSubscription: vi.fn().mockResolvedValue(false),
            createBillingPortalSession: vi.fn().mockResolvedValue(null),
            cancelSubscription: vi.fn().mockResolvedValue(false),
            resumeSubscription: vi.fn().mockResolvedValue(false),
            getUsageMetrics: vi.fn().mockResolvedValue(null),
        };

        vi.spyOn(PaynlessStore, 'useSubscriptionStore').mockImplementation(<S,>(
            selector?: (state: SubscriptionStore) => S,
            _equalityFn?: (a: S, b: S) => boolean
        ): S | SubscriptionStore => {
            if (typeof selector === 'function') {
                return selector(mockSubscriptionState);
            }
            return mockSubscriptionState;
        });

        // Mock WalletStore
        const mockWalletFullState: WalletStore = {
            ...initialWalletStateValues,
            // Mock actions for WalletStore
            loadPersonalWallet: vi.fn().mockResolvedValue(undefined),
            loadOrganizationWallet: vi.fn().mockResolvedValue(undefined),
            getOrLoadOrganizationWallet: vi.fn().mockResolvedValue(null),
            loadTransactionHistory: vi.fn().mockResolvedValue(undefined),
            initiatePurchase: vi.fn().mockResolvedValue(null),
            _resetForTesting: vi.fn(),
            determineChatWallet: vi.fn().mockReturnValue({ walletType: 'personal', walletId: 'test-personal-wallet' }),
            // Ensure selectCurrentWalletBalance is available if it were a direct method (it's not, but good to be aware)
            // For selector-based access, the selector itself is applied to this state.
        };

        vi.spyOn(PaynlessStore, 'useWalletStore').mockImplementation(<S,>(
            selector?: (state: WalletStore) => S,
            _equalityFn?: (a: S, b: S) => boolean
        ): S | WalletStore => {
            // If a selector is provided (like selectPersonalWalletBalance), apply it to the mock state
            // Otherwise, return the whole mock state (standard Zustand behavior)
            if (typeof selector === 'function') {
                return selector(mockWalletFullState);
            }
            return mockWalletFullState;
        });

        // Spy on useAuthStore to use the updated mockedUseAuthStoreHookLogic
        // The mockedUseAuthStoreHookLogic itself now handles the full AuthStore type and the equalityFn
        vi.spyOn(PaynlessStore, 'useAuthStore').mockImplementation(mockedUseAuthStoreHookLogic);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should render Header and Footer when not loading', async () => {
        // Set auth store state for this test using helpers
        mockSetAuthIsLoading(false);
        mockSetAuthUser(null); // Or a mock user if needed
        mockSetAuthSession(null); // Or a mock session if needed

        // No need to re-spy in each test if done in beforeEach and resetAuthStoreMock handles state
        // vi.spyOn(PaynlessStore, 'useAuthStore').mockImplementation(mockedUseAuthStoreHookLogic);

        await act(async () => {
            render(<App />);
        });

    });

    it('should render loading spinner when auth is loading', async () => {
        // Set auth store state for this test
        mockSetAuthIsLoading(true);
        mockSetAuthUser(null);
        mockSetAuthSession(null);

        // No need to re-spy
        // vi.spyOn(PaynlessStore, 'useAuthStore').mockImplementation(mockedUseAuthStoreHookLogic);

        await act(async () => {
          render(<App />);
        });

        // Assertions
        expect(await screen.findByRole('status')).toBeInTheDocument(); 
        expect(screen.queryByRole('banner')).not.toBeInTheDocument(); 
        expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
    });

});
