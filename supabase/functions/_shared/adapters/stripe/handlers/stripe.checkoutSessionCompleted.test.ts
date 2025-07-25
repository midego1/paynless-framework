import { StripePaymentAdapter } from '../stripePaymentAdapter.ts';
import type { ITokenWalletService, TokenWalletTransaction } from '../../../types/tokenWallet.types.ts';
import { MockTokenWalletService } from '../../../services/tokenWalletService.mock.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js';
import { Database } from "../../../../types_db.ts";
import Stripe from 'npm:stripe';
import type { PaymentConfirmation } from '../../../types/payment.types.ts';
import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  assertSpyCalls,
  spy,
  stub,
  type Stub,
  type Spy,
} from 'jsr:@std/testing@0.225.1/mock';
import { createMockStripe, MockStripe, HandlerContext } from '../../../stripe.mock.ts';
import { createMockSupabaseClient, MockSupabaseClientSetup, MockSupabaseDataConfig } from '../../../supabase.mock.ts';
import { createMockTokenWalletService } from '../../../services/tokenWalletService.mock.ts';
import { handleCheckoutSessionCompleted } from "./stripe.checkoutSessionCompleted.ts";
import type { PaymentTransaction, ILogger, LogMetadata } from "../../../types.ts";

// Helper to create a mock Stripe.Event
const createMockCheckoutSessionCompletedEvent = (
  sessionData: Partial<Stripe.Checkout.Session>,
  id = `evt_test_${Date.now()}`
): Stripe.CheckoutSessionCompletedEvent => {
  return {
    id,
    object: "event",
    api_version: "2020-08-27",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: `cs_test_${Date.now()}`,
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        mode: "payment",
        currency: "usd",
        amount_total: 1000,
        customer: null,
        customer_details: null,
        payment_intent: `pi_test_${Date.now()}`,
        subscription: null,
        client_reference_id: `user_test_${Date.now()}`,
        metadata: { internal_payment_id: `ptxn_test_${Date.now()}` },
        ...sessionData,
      } as Stripe.Checkout.Session,
    },
    livemode: false,
    pending_webhooks: 0,
    request: { id: `req_test_${Date.now()}`, idempotency_key: null },
    type: "checkout.session.completed",
  } as Stripe.CheckoutSessionCompletedEvent;
};

// Mock Logger
const createMockLoggerInternal = (): ILogger => { // Renamed to avoid conflict if any
    return {
        debug: spy((_message: string, _metadata?: LogMetadata) => {}),
        info: spy((_message: string, _metadata?: LogMetadata) => {}),
        warn: spy((_message: string, _metadata?: LogMetadata) => {}),
        error: spy((_message: string | Error, _metadata?: LogMetadata) => {}),
    };
};

Deno.test('StripePaymentAdapter: handleWebhook', async (t) => {
  let mockStripe: MockStripe;
  let mockSupabaseSetup: MockSupabaseClientSetup;
  let mockTokenWalletService: MockTokenWalletService;
  let adapter: StripePaymentAdapter;

  const MOCK_SITE_URL = 'http://localhost:3000';
  const MOCK_WEBHOOK_SECRET = 'whsec_test_valid_secret';
  const MOCK_USER_ID = 'usr_webhook_test_user';
  const MOCK_WALLET_ID = 'wlt_webhook_test_wallet';
  const MOCK_PAYMENT_TRANSACTION_ID = 'ptxn_webhook_test_123';
  const MOCK_STRIPE_CHECKOUT_SESSION_ID = 'cs_test_webhook_session_abc123';
  const MOCK_STRIPE_PAYMENT_INTENT_ID = 'pi_test_webhook_payment_intent_def456';
  const tokens_to_award = 500;

  const setupMocksAndAdapterForWebhook = (supabaseConfig: MockSupabaseDataConfig = {}) => {
    Deno.env.set('SITE_URL', MOCK_SITE_URL);
    Deno.env.set('STRIPE_WEBHOOK_SECRET', MOCK_WEBHOOK_SECRET);
    mockStripe = createMockStripe();
    mockSupabaseSetup = createMockSupabaseClient(undefined, supabaseConfig);
    mockTokenWalletService = createMockTokenWalletService();

    adapter = new StripePaymentAdapter(
      mockStripe.instance,
      mockSupabaseSetup.client as unknown as SupabaseClient,
      mockTokenWalletService.instance,
      MOCK_WEBHOOK_SECRET
    );
  };

  const teardownWebhookMocks = () => {
    Deno.env.delete('SITE_URL');
    Deno.env.delete('STRIPE_WEBHOOK_SECRET');
    mockStripe.clearStubs();
    mockTokenWalletService.clearStubs();
  };

  await t.step('handleWebhook - checkout.session.completed - one-time purchase', async () => {
    const internalPaymentId = 'ptxn_webhook_otp_completed_123';
    const stripeSessionId = 'cs_webhook_otp_completed_456';
    const userId = 'user-webhook-otp';
    const walletId = 'wallet-for-user-webhook-otp';
    const tokensToAward = 100;

    // 1. Mock Stripe Event Data
    const mockStripeSession: Partial<Stripe.Checkout.Session> = {
      id: stripeSessionId,
      object: 'checkout.session',
      status: 'complete', 
      payment_status: 'paid', 
      client_reference_id: userId,
      mode: 'payment',
      metadata: {
        internal_payment_id: internalPaymentId,
        user_id: userId,
      },
    };

    const mockStripeEvent = createMockCheckoutSessionCompletedEvent(mockStripeSession, 'evt_webhook_otp_completed_789');

    // 2. Mock payment_transactions table data (initial state)
    const initialPaymentTxnData = {
      id: internalPaymentId,
      user_id: userId,
      target_wallet_id: walletId,
      tokens_to_award: tokensToAward,
      status: 'PENDING', // Initial status
      gateway_transaction_id: null, // Not yet set
      item_id: 'item-otp-webhook',
      // ... other fields
    };

    // 3. Setup Mocks
    const supabaseConfig: MockSupabaseDataConfig = {
      genericMockResults: {
        'payment_transactions': {
          select: async (state) => {
            if (state.filters.some(f => f.column === 'id' && f.value === internalPaymentId)) {
              return { data: [initialPaymentTxnData], error: null, count: 1, status: 200, statusText: 'OK' };
            }
            return { data: [], error: new Error('Mock: Payment txn not found'), count: 0, status: 404, statusText: 'Not Found' };
          },
          update: async (state) => { // Should be called to update status to COMPLETED
            const updateData = state.updateData as { status?: string, gateway_transaction_id?: string }; // Type assertion for updateData
            if (state.filters.some(f => f.column === 'id' && f.value === internalPaymentId) && updateData?.status === 'COMPLETED') {
              return { data: [{ ...initialPaymentTxnData, status: 'COMPLETED', gateway_transaction_id: stripeSessionId }], error: null, count: 1, status: 200, statusText: 'OK' };
            }
            return { data: null, error: new Error('Mock: Payment txn update failed'), count: 0, status: 500, statusText: 'Error' };
          }
        }
      }
    };
    setupMocksAndAdapterForWebhook(supabaseConfig);

    // Mock stripe.webhooks.constructEventAsync
    if (mockStripe.stubs.webhooksConstructEvent?.restore) mockStripe.stubs.webhooksConstructEvent.restore();
    mockStripe.stubs.webhooksConstructEvent = stub(mockStripe.instance.webhooks, "constructEventAsync", (_payload: any, _sig: any, _secret: any): Promise<Stripe.Event> => {
      return Promise.resolve(mockStripeEvent);
    });

    // Mock tokenWalletService.recordTransaction
    const mockTokenTxResult: TokenWalletTransaction = { 
        transactionId: 'tokentx_webhook_otp_123',
        walletId: walletId,
        type: 'CREDIT_PURCHASE',
        amount: tokensToAward.toString(),
        balanceAfterTxn: (parseInt(initialPaymentTxnData.status === 'PENDING' ? '0' : '0') + tokensToAward).toString(),
        recordedByUserId: userId,
        relatedEntityId: internalPaymentId,
        relatedEntityType: 'payment_transaction',
        idempotencyKey: `evt_webhook_otp_completed_789_${internalPaymentId}`,
        timestamp: new Date(),
        notes: 'Tokens awarded from Stripe payment'
    };
    if (mockTokenWalletService.stubs.recordTransaction?.restore) mockTokenWalletService.stubs.recordTransaction.restore();
    mockTokenWalletService.stubs.recordTransaction = stub(
        mockTokenWalletService.instance, 
        "recordTransaction", 
        (params): Promise<TokenWalletTransaction> => {
            assertEquals(params.walletId, walletId);
            assertEquals(params.amount, tokensToAward.toString());
            assertEquals(params.type, 'CREDIT_PURCHASE');
            assertEquals(params.relatedEntityId, internalPaymentId);
            return Promise.resolve(mockTokenTxResult);
        }
    );

    // 4. Call handleWebhook
    const rawBodyString = JSON.stringify(mockStripeEvent);
    const dummySignature = 'whsec_test_signature';
    const rawBodyArrayBuffer = new TextEncoder().encode(rawBodyString).buffer as ArrayBuffer;

    const result = await adapter.handleWebhook(rawBodyArrayBuffer, dummySignature);

    // 5. Assertions
    assert(result.success, `Webhook handling should be successful. Error: ${result.error}`);
    assertEquals(result.transactionId, internalPaymentId, 'Incorrect internal transactionId in result');
    assertEquals(result.tokensAwarded, tokensToAward, 'Incorrect tokensAwarded in result');

    // Check that constructEvent was called
    assertSpyCalls(mockStripe.stubs.webhooksConstructEvent, 1);
    
    // Assert that from('payment_transactions') was called (at least for select and update)
    // Depending on the execution path, it might be called once (if update is skipped) or twice.
    assert(mockSupabaseSetup.spies.fromSpy.calls.some((call: { args: any[] }) => call.args[0] === 'payment_transactions'), "from('payment_transactions') should have been called at least once.");
    const paymentTransactionsFromCalls = mockSupabaseSetup.spies.fromSpy.calls.filter((call: { args: any[] }) => call.args[0] === 'payment_transactions').length;
    console.log(`DEBUG: from('payment_transactions') called ${paymentTransactionsFromCalls} times (OTP).`);

    // Check DB calls by iterating over historic builders
    const historicPaymentTxBuildersOtp = (mockSupabaseSetup.client as any).getHistoricBuildersForTable('payment_transactions');
    assert(historicPaymentTxBuildersOtp && historicPaymentTxBuildersOtp.length > 0, "No historic query builders found for payment_transactions (OTP)");

    const totalSelectCallsOtp = historicPaymentTxBuildersOtp.reduce((sum: number, builder: { methodSpies: { select?: { calls: { length: number }[] } } }) => {
      return sum + (builder.methodSpies.select?.calls?.length || 0);
    }, 0);
    assertEquals(totalSelectCallsOtp, 2, "select should have been called twice on payment_transactions (OTP)");

    const totalUpdateCallsOtp = historicPaymentTxBuildersOtp.reduce((sum: number, builder: { methodSpies: { update?: { calls: { length: number }[] } } }) => {
      return sum + (builder.methodSpies.update?.calls?.length || 0);
    }, 0);
    assertEquals(totalUpdateCallsOtp, 1, "update should have been called once on payment_transactions (OTP)");

    // Check token wallet service call
    assertSpyCalls(mockTokenWalletService.stubs.recordTransaction, 1);
    const recordTxArgs = mockTokenWalletService.stubs.recordTransaction.calls[0].args[0];
    assertEquals(recordTxArgs.walletId, walletId, "recordTransaction called with incorrect walletId");
    assertEquals(recordTxArgs.amount, tokensToAward.toString(), "recordTransaction called with incorrect amount");
    assertEquals(recordTxArgs.type, 'CREDIT_PURCHASE', "recordTransaction called with incorrect type");

    teardownWebhookMocks();
  });

  await t.step('handleWebhook - checkout.session.completed - subscription', async () => {
    // Similar structure to the OTP test, but with subscription-specific data if necessary
    const internalPaymentId = 'ptxn_webhook_sub_completed_789'; // New ID for clarity
    const stripeSessionId = 'cs_webhook_sub_completed_session_abc';
    const userId = 'user_webhook_sub_test';
    const walletId = 'wlt_webhook_sub_test_wallet';
    const tokensToAward = 1500;
    const itemIdInternal = 'item_sub_premium_webhook'; // Will be in session metadata
    const stripeSubscriptionId = 'sub_webhook_test_premium_123';
    const stripeCustomerId = 'cus_webhook_test_customer_456';
    const internalPlanId = 'plan_internal_premium_789'; // From subscription_plans table

    const mockStripeSubscriptionObject: Partial<Stripe.Subscription> = {
      id: stripeSubscriptionId,
      status: 'active',
      customer: stripeCustomerId,
      items: {
        object: 'list',
        data: [
          {
            id: 'si_mock_item',
            object: 'subscription_item',
            billing_thresholds: null,
            created: Math.floor(Date.now() / 1000),
            metadata: {},
            plan: { id: 'plan_mock' } as Stripe.Plan,
            price: { id: 'price_mock' } as Stripe.Price,
            quantity: 1,
            subscription: stripeSubscriptionId,
            tax_rates: [],
            discounts: [],
            current_period_start: Math.floor(Date.now() / 1000) - 3600,
            current_period_end: Math.floor(Date.now() / 1000) + 2592000,
          } as unknown as Stripe.SubscriptionItem,
        ],
        has_more: false,
        url: `/v1/subscriptions/${stripeSubscriptionId}/items`,
      },
      cancel_at_period_end: false,
    };

    // 1. Mock Stripe Event Data
    const mockStripeSession: Partial<Stripe.Checkout.Session> = {
      id: stripeSessionId,
      object: 'checkout.session',
      status: 'complete', 
      payment_status: 'paid', 
      client_reference_id: userId,
      mode: 'subscription', // Key for this test
      subscription: stripeSubscriptionId, // Stripe Subscription ID
      customer: stripeCustomerId,       // Stripe Customer ID
      metadata: {
        internal_payment_id: internalPaymentId,
        user_id: userId,
        item_id: itemIdInternal, // Used to lookup internal plan_id
      },
    };

    const mockStripeEvent: Stripe.Event = {
      id: 'evt_webhook_sub_completed_xyz', // New event ID
      object: 'event',
      type: 'checkout.session.completed',
      api_version: '2020-08-27', 
      created: Math.floor(Date.now() / 1000),
      data: {
        object: mockStripeSession as Stripe.Checkout.Session, 
      },
      livemode: false,
      pending_webhooks: 0,
      request: { id: 'req_webhook_sub_test', idempotency_key: null },
    };

    // 2. Mock payment_transactions table data (initial state)
    const initialPaymentTxnData = {
      id: internalPaymentId,
      user_id: userId,
      target_wallet_id: walletId,
      tokens_to_award: tokensToAward,
      status: 'PENDING', 
      gateway_transaction_id: null,
      // metadata_json: { itemId: itemIdInternal }, // Alternative to session.metadata.item_id
      // item_id is not a direct column on payment_transactions, usually in metadata if stored there
    };

    // 3. Setup Mocks
    const supabaseConfig: MockSupabaseDataConfig = {
      genericMockResults: {
        'payment_transactions': {
          select: async (state: any) => {
            if (state.filters.some((f: any) => f.column === 'id' && f.value === internalPaymentId)) {
              return { data: [initialPaymentTxnData], error: null, count: 1, status: 200, statusText: 'OK' };
            }
            return { data: [], error: new Error('Mock: Payment txn not found for subscription test'), count: 0, status: 404, statusText: 'Not Found' };
          },
          update: async (state: any) => { 
            const updateData = state.updateData as { status?: string, gateway_transaction_id?: string }; 
            if (state.filters.some((f: any) => f.column === 'id' && f.value === internalPaymentId) && updateData?.status === 'COMPLETED') {
              return { data: [{ ...initialPaymentTxnData, status: 'COMPLETED', gateway_transaction_id: stripeSessionId }], error: null, count: 1, status: 200, statusText: 'OK' };
            }
            return { data: null, error: new Error('Mock: Payment txn update failed for subscription test'), count: 0, status: 500, statusText: 'Error' };
          }
        },
        'subscription_plans': { // Mock for fetching internal plan_id in the first test suite
          select: async (state: any) => {
            if (state.filters.some((f: any) => f.column === 'stripe_price_id' && f.value === itemIdInternal)) {
              return { data: [{ id: internalPlanId }], error: null, count: 1, status: 200, statusText: 'OK' };
            }
            return { data: [], error: new Error(`Mock: Subscription plan not found for stripe_price_id ${itemIdInternal}`), count: 0, status: 404, statusText: 'Not Found' };
          }
        },
        'user_subscriptions': { // MODIFIED MOCK for upserting user subscription
          upsert: async (state: any) => {
            const upsertData = state.upsertData as any; 
            if (upsertData && upsertData.stripe_subscription_id === stripeSubscriptionId) {
              assertEquals(upsertData.user_id, userId);
              assertEquals(upsertData.plan_id, internalPlanId);
              assertEquals(upsertData.status, mockStripeSubscriptionObject.status);
              return { data: [upsertData], error: null, count: 1, status: 200, statusText: 'OK' }; 
            }
            return { data: null, error: new Error('Mock: User subscription upsert failed condition check'), count: 0, status: 500, statusText: 'Error' };
          }
        }
      }
    };
    setupMocksAndAdapterForWebhook(supabaseConfig);

    // Mock stripe.webhooks.constructEventAsync
    if (mockStripe.stubs.webhooksConstructEvent?.restore) mockStripe.stubs.webhooksConstructEvent.restore();
    mockStripe.stubs.webhooksConstructEvent = stub(mockStripe.instance.webhooks, "constructEventAsync", (_payload: any, _sig: any, _secret: any): Promise<Stripe.Event> => {
      return Promise.resolve(mockStripeEvent);
    });

    // Ensure subscriptionsRetrieve stub is available on mockStripe.stubs
    if (mockStripe.stubs.subscriptionsRetrieve && typeof mockStripe.stubs.subscriptionsRetrieve.restore === 'function') {
      mockStripe.stubs.subscriptionsRetrieve.restore();
    }
    mockStripe.stubs.subscriptionsRetrieve = stub(mockStripe.instance.subscriptions, "retrieve", 
      async (id: string): Promise<Stripe.Response<Stripe.Subscription>> => { // Original simpler signature for this specific test case's needs
        assertEquals(id, stripeSubscriptionId, "Stripe subscriptions.retrieve called with wrong ID");
        return Promise.resolve({
          ...mockStripeSubscriptionObject, 
          lastResponse: { headers: {}, requestId: 'req_mock_sub_retrieve', statusCode: 200, apiVersion: undefined, idempotencyKey: undefined, stripeAccount: undefined } 
        } as Stripe.Response<Stripe.Subscription>);
      }
    );


    // Mock tokenWalletService.recordTransaction
    const mockTokenTxResultSub: TokenWalletTransaction = { 
        transactionId: 'tokentx_webhook_sub_xyz789', // New ID
        walletId: walletId,
        type: 'CREDIT_PURCHASE',
        amount: tokensToAward.toString(),
        balanceAfterTxn: (parseInt(initialPaymentTxnData.status === 'PENDING' ? '0' : '0') + tokensToAward).toString(), 
        recordedByUserId: userId,
        relatedEntityId: internalPaymentId,
        relatedEntityType: 'payment_transactions',
        idempotencyKey: `${mockStripeEvent.id}_${internalPaymentId}`,
        timestamp: new Date(),
        notes: `Tokens for Stripe Checkout Session ${stripeSessionId} (mode: subscription)` // Note updated
    };
    if (mockTokenWalletService.stubs.recordTransaction?.restore) mockTokenWalletService.stubs.recordTransaction.restore();
    mockTokenWalletService.stubs.recordTransaction = stub(
        mockTokenWalletService.instance, 
        "recordTransaction", 
        (params): Promise<TokenWalletTransaction> => {
            assertEquals(params.walletId, walletId);
            assertEquals(params.amount, tokensToAward.toString());
            assertEquals(params.type, 'CREDIT_PURCHASE');
            assertEquals(params.relatedEntityId, internalPaymentId);
            assertEquals(params.notes, `Tokens for Stripe Checkout Session ${stripeSessionId} (mode: subscription)`);
            return Promise.resolve(mockTokenTxResultSub);
        }
    );

    // 4. Call handleWebhook
    const rawBodyString = JSON.stringify(mockStripeEvent);
    const dummySignature = 'whsec_test_subscription_signature';
    const rawBodyArrayBuffer = new TextEncoder().encode(rawBodyString).buffer as ArrayBuffer;

    const result: PaymentConfirmation = await adapter.handleWebhook(rawBodyArrayBuffer, dummySignature);

    // 5. Assertions
    assert(result.success, `Subscription Webhook handling should be successful. Error: ${result.error}`);
    assertEquals(result.transactionId, internalPaymentId, 'Incorrect internal transactionId in subscription result');
    assertEquals(result.tokensAwarded, tokensToAward, 'Incorrect tokensAwarded in subscription result');

    // Check that constructEvent was called
    assertSpyCalls(mockStripe.stubs.webhooksConstructEvent, 1);
    
    // Check Stripe SDK calls
    assertSpyCalls(mockStripe.stubs.subscriptionsRetrieve, 1);
    
    // Check DB calls by iterating over historic builders
    const historicPaymentTxBuildersSub = (mockSupabaseSetup.client as any).getHistoricBuildersForTable('payment_transactions');
    assert(historicPaymentTxBuildersSub && historicPaymentTxBuildersSub.length > 0, "No historic query builders found for payment_transactions (Sub)");

    const totalSelectCallsSub = historicPaymentTxBuildersSub.reduce((sum: number, builder: { methodSpies: { select?: { calls: { length: number }[] } } }) => {
      return sum + (builder.methodSpies.select?.calls?.length || 0);
    }, 0);
    assertEquals(totalSelectCallsSub, 2, "select should have been called twice on payment_transactions (Sub)");

    const totalUpdateCallsSub = historicPaymentTxBuildersSub.reduce((sum: number, builder: { methodSpies: { update?: { calls: { length: number }[] } } }) => {
      return sum + (builder.methodSpies.update?.calls?.length || 0);
    }, 0);
    assertEquals(totalUpdateCallsSub, 1, "update should have been called once on payment_transactions (Sub)");
    
    // Accessing arguments of the update call from the relevant builder
    // Assuming the update call is on the second builder instance in this flow (first is select, second is update)
    const updateBuilderInstanceSub = historicPaymentTxBuildersSub.find(
      (b: { methodSpies: { update?: { calls?: { length: number }[], callsArgs?: any[][] } } }) => 
        b.methodSpies.update?.calls && b.methodSpies.update.calls.length > 0
    );
    assert(updateBuilderInstanceSub, "Could not find the builder instance that performed the update (Sub)");
    assert(updateBuilderInstanceSub.methodSpies.update?.calls && updateBuilderInstanceSub.methodSpies.update.calls.length > 0 && updateBuilderInstanceSub.methodSpies.update.calls[0].args.length > 0, "Update call arguments not found in spy calls (Sub)");
    const updateObject = updateBuilderInstanceSub.methodSpies.update.calls[0].args[0] as { status?: string; gateway_transaction_id?: string };

    assertEquals(updateObject.status, 'COMPLETED');
    assertEquals(updateObject.gateway_transaction_id, stripeSessionId);


    const subPlansSelectSpies = (mockSupabaseSetup.client as any).getHistoricBuildersForTable('subscription_plans');
    assert(subPlansSelectSpies && subPlansSelectSpies.length > 0, "Historic select spies info should exist for subscription_plans (Sub)");
    const totalSubPlansSelectCalls = subPlansSelectSpies.reduce((sum: number, builder: { methodSpies: { select?: { calls: { length: number }[] } } }) => {
      return sum + (builder.methodSpies.select?.calls?.length || 0);
    }, 0);
    assertEquals(totalSubPlansSelectCalls, 1, "select on subscription_plans should have been called once (Sub)");
    
    const subPlansBuilderInstance = subPlansSelectSpies[0]; // Assuming first builder is the one we need
    assert(subPlansBuilderInstance?.methodSpies.eq, "Eq spy not found on subscription_plans builder");
    assert(subPlansBuilderInstance.methodSpies.eq.calls && subPlansBuilderInstance.methodSpies.eq.calls.length > 0, "No calls found for eq on subscription_plans");
    assert(subPlansBuilderInstance.methodSpies.eq.calls[0].args && subPlansBuilderInstance.methodSpies.eq.calls[0].args.length > 0, "No call arguments for eq on subscription_plans");
    assertEquals(subPlansBuilderInstance.methodSpies.eq.calls[0].args, ['stripe_price_id', itemIdInternal], "eq on subscription_plans called with wrong stripe_price_id");


    const userSubUpsertSpies = (mockSupabaseSetup.client as any).getHistoricBuildersForTable('user_subscriptions');
    assert(userSubUpsertSpies && userSubUpsertSpies.length > 0, "Historic upsert spies info should exist for user_subscriptions (Sub)");
    const totalUserSubUpsertCalls = userSubUpsertSpies.reduce((sum: number, builder: { methodSpies: { upsert?: { calls: { length: number }[] } } }) => {
      return sum + (builder.methodSpies.upsert?.calls?.length || 0);
    }, 0);
    assertEquals(totalUserSubUpsertCalls, 1, "upsert on user_subscriptions should have been called once (Sub)");
    
    const userSubBuilderInstance = userSubUpsertSpies[0]; // Assuming first builder
    assert(userSubBuilderInstance?.methodSpies.upsert, "Upsert spy not found on user_subscriptions builder");
    assert(userSubBuilderInstance.methodSpies.upsert.calls && userSubBuilderInstance.methodSpies.upsert.calls.length > 0, "No calls found for upsert on user_subscriptions");
    assert(userSubBuilderInstance.methodSpies.upsert.calls[0].args && userSubBuilderInstance.methodSpies.upsert.calls[0].args.length > 0, "No call arguments for upsert on user_subscriptions");
    const upsertDataArray = userSubBuilderInstance.methodSpies.upsert.calls[0].args; // Accessing the data object from the call
    assert(upsertDataArray && upsertDataArray.length > 0, "Upsert data not found");
    const upsertData = upsertDataArray[0];

    assertEquals(upsertData.user_id, userId, "user_subscriptions upserted with wrong user_id");
    assertEquals(upsertData.plan_id, internalPlanId, "user_subscriptions upserted with wrong plan_id");
    assertEquals(upsertData.stripe_subscription_id, stripeSubscriptionId, "user_subscriptions upserted with wrong stripe_subscription_id");
    assertEquals(upsertData.status, mockStripeSubscriptionObject.status, "user_subscriptions upserted with wrong status");


    // Check token wallet service call
    assertSpyCalls(mockTokenWalletService.stubs.recordTransaction, 1);
    const recordTxArgsSub = mockTokenWalletService.stubs.recordTransaction.calls[0].args[0];
    assertEquals(recordTxArgsSub.walletId, walletId, "recordTransaction called with incorrect walletId for sub");
    assertEquals(recordTxArgsSub.amount, tokensToAward.toString(), "recordTransaction called with incorrect amount for sub");
    assertEquals(recordTxArgsSub.type, 'CREDIT_PURCHASE', "recordTransaction called with incorrect type for sub");

    teardownWebhookMocks();
  });

});

Deno.test("[stripe.checkoutSessionCompleted.ts] Tests", async (t) => {
  let mockSupabaseClient: SupabaseClient<Database>;
  let mockSupabaseSetup: MockSupabaseClientSetup;
  let mockTokenWalletService: MockTokenWalletService;
  let mockLogger: ILogger;
  let mockUpdatePaymentTransaction: Spy<any, any[], any>; 
  let mockStripe: MockStripe;
  let handlerContext: HandlerContext;

  let subscriptionsRetrieveStub: Stub<Stripe.SubscriptionsResource, [id: string, params?: Stripe.SubscriptionRetrieveParams, options?: Stripe.RequestOptions], Promise<Stripe.Response<Stripe.Subscription>>>;
  let recordTokenTransactionStub: Stub<ITokenWalletService, Parameters<ITokenWalletService['recordTransaction']>, ReturnType<ITokenWalletService['recordTransaction']>>;

  const setup = (dbQueryResults?: { 
    paymentTransaction?: Partial<PaymentTransaction> | null;
    subscriptionPlans?: { id: string; item_id_internal?: string; }[] | null;
    userSubscriptionUpsertError?: Error | null;
    stripeSubscriptionRetrieveResult?: Partial<Stripe.Subscription> | Error | null;
    tokenWalletRecordTransactionResult?: TokenWalletTransaction | Error;
  }) => {
    mockLogger = createMockLoggerInternal();
    mockTokenWalletService = createMockTokenWalletService();
    mockUpdatePaymentTransaction = spy((_id, _updates, _eventId) => 
      Promise.resolve({ 
        ...(dbQueryResults?.paymentTransaction || { id: _id }), 
        status: 'COMPLETED', 
      } as PaymentTransaction)
    );
    mockStripe = createMockStripe();
    
    const genericMockResults: MockSupabaseDataConfig['genericMockResults'] = {};
    if (dbQueryResults?.paymentTransaction !== undefined) {
      genericMockResults['payment_transactions'] = {
        select: async (state) => {
          if (dbQueryResults.paymentTransaction && state.filters.some(f => f.column === 'id' && f.value === dbQueryResults.paymentTransaction?.id)) {
            return { data: [dbQueryResults.paymentTransaction], error: null, count: 1, status: 200, statusText: 'OK' };
          } else if (dbQueryResults.paymentTransaction === null) {
            return { data: null, error: new Error('Mock Not found'), count: 0, status: 404, statusText: 'Not Found' };
          }
          return { data: [], error: new Error('Mock: Payment txn not found by general query'), count: 0, status: 404, statusText: 'Not Found' };
        }
      };
    }
    if (dbQueryResults?.subscriptionPlans !== undefined) {
      genericMockResults['subscription_plans'] = {
        select: async (state: any) => {
          const stripePriceIdFilter = state.filters.find((f: any) => f.column === 'stripe_price_id');
          if (dbQueryResults.subscriptionPlans && stripePriceIdFilter) {
            const filteredPlans = dbQueryResults.subscriptionPlans.filter((p: any) => p.item_id_internal === stripePriceIdFilter.value);
            return { data: filteredPlans.length > 0 ? [filteredPlans[0]] : [], error: null, count: filteredPlans.length > 0 ? 1 : 0, status: 200, statusText: 'OK' };
          } else if (dbQueryResults.subscriptionPlans === null) {
             return { data: null, error: new Error('Mock Not found'), count: 0, status: 404, statusText: 'Not Found' };
          }
          return { data: [], error: new Error('Mock: Subscription plan not found (no matching stripe_price_id filter or no plans in mockData)'), count: 0, status: 404, statusText: 'Not Found' };
        }
      };
    }
    if (dbQueryResults?.userSubscriptionUpsertError !== undefined || dbQueryResults?.userSubscriptionUpsertError === null) {
        genericMockResults['user_subscriptions'] = {
            upsert: async (_state) => {
                return { data: dbQueryResults.userSubscriptionUpsertError ? null : [{}], error: dbQueryResults.userSubscriptionUpsertError, count: dbQueryResults.userSubscriptionUpsertError ? 0 : 1, status: 200, statusText: 'OK' };
            }
        };
    }

    mockSupabaseSetup = createMockSupabaseClient(undefined, { genericMockResults });
    mockSupabaseClient = mockSupabaseSetup.client as unknown as SupabaseClient<Database>;
    
    // Restore the default stub for subscriptions.retrieve created by createMockStripe()
    if (mockStripe.stubs.subscriptionsRetrieve?.restore) {
        mockStripe.stubs.subscriptionsRetrieve.restore();
    }

    subscriptionsRetrieveStub = stub(
      mockStripe.instance.subscriptions, 
      "retrieve", 
      ((id: string, params?: Stripe.SubscriptionRetrieveParams, options?: Stripe.RequestOptions) => { 
        const res = dbQueryResults?.stripeSubscriptionRetrieveResult;
        if (res instanceof Error) return Promise.reject(res);
        const partialSub = res || {};
        return Promise.resolve({
          ...partialSub, 
          id: id, 
          object: 'subscription', 
          lastResponse: { 
            headers: {},
            requestId: `req_mock_standalone_retrieve_${id}`,
            statusCode: 200,
            apiVersion: undefined, 
            idempotencyKey: undefined, 
            stripeAccount: undefined 
          }
        } as Stripe.Response<Stripe.Subscription>);
      }) as any 
    ) as Stub<Stripe.SubscriptionsResource, [id: string, params?: Stripe.SubscriptionRetrieveParams, options?: Stripe.RequestOptions], Promise<Stripe.Response<Stripe.Subscription>>>;

    // Restore the default stub for recordTransaction from mockTokenWalletService if it pre-stubs it.
    // Assuming createMockTokenWalletService() might also pre-stub its methods and store them in `stubs`.
    if (mockTokenWalletService.stubs?.recordTransaction?.restore) {
        mockTokenWalletService.stubs.recordTransaction.restore();
    }

    recordTokenTransactionStub = stub(mockTokenWalletService.instance, "recordTransaction", 
      () => {
        const res = dbQueryResults?.tokenWalletRecordTransactionResult;
        if (res instanceof Error) return Promise.reject(res);
        return Promise.resolve(res || { transactionId: "mock_ttx" } as TokenWalletTransaction);
      }
    );
    
    handlerContext = {
      supabaseClient: mockSupabaseClient,
      logger: mockLogger,
      tokenWalletService: mockTokenWalletService.instance,
      updatePaymentTransaction: mockUpdatePaymentTransaction,
      stripe: mockStripe.instance, 
      featureFlags: {},
      functionsUrl: "http://localhost:54321/functions/v1",
      stripeWebhookSecret: "whsec_test_secret",
    };
  };

  await t.step("handleCheckoutSessionCompleted - one-time payment - success", async () => {
    const internalPaymentId = "ptxn_otp_success";
    const gatewayTxId = "cs_otp_success";
    const userId = "user_otp_success";
    const walletId = "wallet_otp_success";
    const tokensToAward = 100;

    const mockPaymentTxData: Partial<PaymentTransaction> = {
      id: internalPaymentId,
      user_id: userId,
      target_wallet_id: walletId,
      tokens_to_award: tokensToAward,
      status: "PENDING",
      payment_gateway_id: "stripe",
      gateway_transaction_id: null,
      metadata_json: { itemId: "item_otp_success" },
    };
    const mockTokenTx = { transactionId: "ttx_success_otp" } as TokenWalletTransaction;

    setup({ 
      paymentTransaction: mockPaymentTxData,
      tokenWalletRecordTransactionResult: mockTokenTx 
    });

    const event = createMockCheckoutSessionCompletedEvent({
      id: gatewayTxId,
      mode: "payment",
      metadata: { internal_payment_id: internalPaymentId },
      client_reference_id: userId,
    });

    const result = await handleCheckoutSessionCompleted(handlerContext, event);

    assert(result.success, `Expected success, got error: ${result.error}`);
    assertEquals(result.transactionId, internalPaymentId);
    assertEquals(result.paymentGatewayTransactionId, gatewayTxId);
    assertEquals(result.tokensAwarded, tokensToAward);

    assertSpyCalls(mockSupabaseSetup.spies.fromSpy, 1);
    assertEquals(mockSupabaseSetup.spies.fromSpy.calls[0].args[0], "payment_transactions");
    
    const paymentTxBuilder = mockSupabaseSetup.client.getLatestBuilder('payment_transactions');
    assert(paymentTxBuilder, "Payment transactions query builder was not used.");
    assert(paymentTxBuilder.methodSpies.select, "Select spy not found on paymentTxBuilder");
    assertSpyCalls(paymentTxBuilder.methodSpies.select, 1);
    assertEquals(paymentTxBuilder.methodSpies.select.calls[0].args[0], "*");

    assert(paymentTxBuilder.methodSpies.eq, "Eq spy not found on paymentTxBuilder");
    assertSpyCalls(paymentTxBuilder.methodSpies.eq, 1);
    assertEquals(paymentTxBuilder.methodSpies.eq.calls[0].args[0], "id");
    assertEquals(paymentTxBuilder.methodSpies.eq.calls[0].args[1], internalPaymentId);

    assert(paymentTxBuilder.methodSpies.single, "Single spy not found on paymentTxBuilder");
    assertSpyCalls(paymentTxBuilder.methodSpies.single, 1);

    assertEquals(mockUpdatePaymentTransaction.calls.length, 1);
    assertEquals(mockUpdatePaymentTransaction.calls[0].args[0], internalPaymentId);
    assertEquals(mockUpdatePaymentTransaction.calls[0].args[1], { status: "COMPLETED", gateway_transaction_id: gatewayTxId });
    assertEquals(mockUpdatePaymentTransaction.calls[0].args[2], event.id);

    assertEquals(recordTokenTransactionStub.calls.length, 1);
    const recordTxArgs = recordTokenTransactionStub.calls[0].args[0];
    assertEquals(recordTxArgs.walletId, walletId);
    assertEquals(recordTxArgs.type, "CREDIT_PURCHASE");
    assertEquals(recordTxArgs.amount, String(tokensToAward));
    assertEquals(recordTxArgs.relatedEntityId, internalPaymentId);
  });

  await t.step("handleCheckoutSessionCompleted - payment transaction not found", async () => {
    const internalPaymentId = "ptxn_not_found";
    const gatewayTxId = "cs_not_found";

    setup({ 
      paymentTransaction: null, // Simulate payment_transaction not found
    });

    const event = createMockCheckoutSessionCompletedEvent({
      id: gatewayTxId,
      mode: "payment",
      metadata: { internal_payment_id: internalPaymentId },
    });

    const result = await handleCheckoutSessionCompleted(handlerContext, event);

    assert(!result.success, "Expected failure when payment transaction is not found");
    assertEquals(result.transactionId, internalPaymentId);
    assertEquals(result.paymentGatewayTransactionId, gatewayTxId);
    assert(result.error?.includes(`Payment transaction not found: ${internalPaymentId}`), `Expected error message about missing payment transaction, got: ${result.error}`);

    // Verify logger was called
    assertSpyCalls(mockLogger.error as Spy<any, any[], any>, 1);
    const errorLogCall = (mockLogger.error as Spy<any, any[], any>).calls[0].args[0];
    assert(String(errorLogCall).includes(`Payment transaction not found: ${internalPaymentId}`), `Unexpected logger error message: ${errorLogCall}`);

    // Verify other services were not called
    assertSpyCalls(mockUpdatePaymentTransaction, 0);
    assertSpyCalls(recordTokenTransactionStub, 0);
  });

  await t.step("handleCheckoutSessionCompleted - payment transaction already completed", async () => {
    const internalPaymentId = "ptxn_already_completed";
    const gatewayTxId = "cs_already_completed";
    const userId = "user_already_completed";
    const walletId = "wallet_already_completed";
    const tokensToAward = 100;

    const mockPaymentTxData: Partial<PaymentTransaction> = {
      id: internalPaymentId,
      user_id: userId,
      target_wallet_id: walletId,
      tokens_to_award: tokensToAward,
      status: "COMPLETED", 
      payment_gateway_id: "stripe",
      gateway_transaction_id: "cs_old_id_original", 
      metadata_json: { itemId: "item_already_completed" },
    };

    setup({ 
      paymentTransaction: mockPaymentTxData,
    });

    const event = createMockCheckoutSessionCompletedEvent({
      id: gatewayTxId, 
      mode: "payment",
      metadata: { internal_payment_id: internalPaymentId },
      client_reference_id: userId,
    });

    const result = await handleCheckoutSessionCompleted(handlerContext, event);

    assert(result.success, "Expected success for an already completed transaction (idempotency)");
    assertEquals(result.transactionId, internalPaymentId);
    assertEquals(result.paymentGatewayTransactionId, mockPaymentTxData.gateway_transaction_id, "Expected original stored gateway_transaction_id to be returned");
    assertEquals(result.tokensAwarded, tokensToAward, "Expected original tokens to be in result");
    assert(result.message?.includes(`Transaction ${internalPaymentId} already processed with status COMPLETED`), `Unexpected message: ${result.message}`);

    // Allow for 2 info calls: 1 from StripePaymentAdapter init, 1 from the handler itself.
    const infoSpy = mockLogger.info as Spy<any, any[], any>; 
    assertSpyCalls(infoSpy, 2); // Expect two info log calls by the handler in this scenario

    // Check the first log call by the handler
    const firstLogCallArgs = infoSpy.calls[0].args[0];
    assert(String(firstLogCallArgs).includes(`Processing for session ${gatewayTxId}, initial internalPaymentId from metadata: ${internalPaymentId}`),
      `Expected first log message to be about processing with metadata, got: ${firstLogCallArgs}`);

    // Check the second log call by the handler
    const secondLogCallArgs = infoSpy.calls[1].args[0];
    assert(String(secondLogCallArgs).includes(`Transaction ${internalPaymentId} already processed with status COMPLETED`),
      `Expected second log message about already completed transaction, got: ${secondLogCallArgs}`);

    assertSpyCalls(mockUpdatePaymentTransaction, 0);
    assertSpyCalls(recordTokenTransactionStub, 0);
  });

  await t.step("handleCheckoutSessionCompleted - payment transaction already failed", async () => {
    const internalPaymentId = "ptxn_already_failed";
    const gatewayTxId = "cs_event_for_already_failed"; // New event ID
    const userId = "user_already_failed";

    const mockPaymentTxData: Partial<PaymentTransaction> = {
      id: internalPaymentId,
      user_id: userId,
      target_wallet_id: "wallet_already_failed",
      tokens_to_award: 0, // Typically 0 for failed
      status: "FAILED", // Already failed
      payment_gateway_id: "stripe",
      gateway_transaction_id: "cs_original_failed_id", // The gateway ID associated with the original failure
      metadata_json: { itemId: "item_already_failed" },
    };

    setup({ 
      paymentTransaction: mockPaymentTxData,
    });

    const event = createMockCheckoutSessionCompletedEvent({
      id: gatewayTxId, 
      mode: "payment",
      metadata: { internal_payment_id: internalPaymentId },
      client_reference_id: userId,
      payment_status: "paid", // Event might look successful
      status: "complete",
    });

    const result = await handleCheckoutSessionCompleted(handlerContext, event);

    // Handler now returns success: true for successful idempotent handling of an already FAILED transaction
    assert(result.success, "Expected success for idempotent handling of an already FAILED transaction");
    assertEquals(result.transactionId, internalPaymentId);
    assertEquals(result.paymentGatewayTransactionId, mockPaymentTxData.gateway_transaction_id, "Expected original stored gateway_transaction_id for already failed txn");
    assertEquals(result.tokensAwarded, 0);
    assert(result.message?.includes(`Transaction ${internalPaymentId} already processed with status FAILED. Original status: FAILED.`), `Unexpected message: ${result.message}`);
    assert(result.error?.includes(`Payment transaction ${internalPaymentId} was previously marked as FAILED.`), `Unexpected error: ${result.error}`);

    assertSpyCalls(mockLogger.warn as Spy<any, any[], any>, 1); // Changed from info to warn
    const warnLogCall = (mockLogger.warn as Spy<any, any[], any>).calls[0].args[0];
    assert(String(warnLogCall).includes(`Transaction ${internalPaymentId} already processed with status FAILED`), `Unexpected logger warn message: ${warnLogCall}`);

    assertSpyCalls(mockUpdatePaymentTransaction, 0);
    assertSpyCalls(recordTokenTransactionStub, 0);
  });

  await t.step("handleCheckoutSessionCompleted - one-time payment - token award fails", async () => {
    const internalPaymentId = "ptxn_token_award_fails";
    const gatewayTxId = "cs_token_award_fails";
    const userId = "user_token_award_fails";
    const walletId = "wallet_token_award_fails";
    const tokensToAward = 100;

    const mockPaymentTxData: Partial<PaymentTransaction> = {
      id: internalPaymentId,
      user_id: userId,
      target_wallet_id: walletId,
      tokens_to_award: tokensToAward,
      status: "PENDING",
      payment_gateway_id: "stripe",
      gateway_transaction_id: null,
      metadata_json: { itemId: "item_token_award_fails" },
    };

    const tokenAwardErrorMessage = "Mock Token Wallet Service: Insufficient funds";
    const tokenAwardError = new Error(tokenAwardErrorMessage);

    setup({ 
      paymentTransaction: mockPaymentTxData,
      tokenWalletRecordTransactionResult: tokenAwardError, 
    });

    const event = createMockCheckoutSessionCompletedEvent({
      id: gatewayTxId,
      mode: "payment",
      metadata: { internal_payment_id: internalPaymentId },
      client_reference_id: userId,
    });

    const result = await handleCheckoutSessionCompleted(handlerContext, event);

    assert(!result.success, "Expected failure when token award fails");
    assertEquals(result.transactionId, internalPaymentId);
    assertEquals(result.paymentGatewayTransactionId, gatewayTxId);
    assert(result.error?.includes(`Failed to award tokens for payment transaction ${internalPaymentId}: ${tokenAwardErrorMessage}`), `Unexpected error: ${result.error}`);
    assertEquals(result.tokensAwarded, 0);

    assertSpyCalls(mockLogger.error as Spy<any, any[], any>, 1); // One for the token awarding exception
    const errorLogCall = (mockLogger.error as Spy<any, any[], any>).calls.find(call => String(call.args[0]).includes("Token awarding exception"));
    assert(errorLogCall, "Expected error log for token awarding exception");
    assert(String(errorLogCall.args[0]).includes(`Token awarding exception for ${internalPaymentId}`), `Unexpected logger error message: ${errorLogCall.args[0]}`);

    assertSpyCalls(mockUpdatePaymentTransaction, 2); // Initial COMPLETED, then TOKEN_AWARD_FAILED
    assertEquals(mockUpdatePaymentTransaction.calls[0].args[1]?.status, "COMPLETED");
    assertEquals(mockUpdatePaymentTransaction.calls[1].args[1]?.status, "TOKEN_AWARD_FAILED");
    
    assertSpyCalls(recordTokenTransactionStub, 1);
  });

  await t.step("handleCheckoutSessionCompleted - subscription - stripe.subscriptions.retrieve fails", async () => {
    const internalPaymentId = "ptxn_sub_retrieve_fails";
    const gatewayTxId = "cs_sub_retrieve_fails"; 
    const stripeSubscriptionId = "sub_retrieve_fails_id"; 
    const userId = "user_sub_retrieve_fails";
    const stripeCustomerId = "cus_sub_retrieve_fails";

    const mockPaymentTxData: Partial<PaymentTransaction> = {
      id: internalPaymentId,
      user_id: userId,
      target_wallet_id: "wallet_sub_retrieve_fails",
      tokens_to_award: 1000,
      status: "PENDING",
      payment_gateway_id: "stripe",
      metadata_json: { itemId: "item_sub_retrieve_fails" },
    };

    const retrieveErrorMessage = "Mock Stripe SDK: Subscription not found";
    const retrieveError = new Error(retrieveErrorMessage);

    setup({ 
      paymentTransaction: mockPaymentTxData,
      stripeSubscriptionRetrieveResult: retrieveError, 
    });

    const event = createMockCheckoutSessionCompletedEvent({
      id: gatewayTxId, 
      mode: "subscription",
      subscription: stripeSubscriptionId, 
      customer: stripeCustomerId, 
      metadata: { internal_payment_id: internalPaymentId, item_id: "item_sub_retrieve_fails" },
      client_reference_id: userId,
    });

    try {
      await handleCheckoutSessionCompleted(handlerContext, event);
      assert(false, "Expected handleCheckoutSessionCompleted to throw due to subscription retrieval failure.");
    } catch (e) {
      assert(e instanceof Error, "Expected thrown error to be an instance of Error.");
      assertEquals(e.message, retrieveErrorMessage, "Thrown error message does not match expected.");
      
      const errorSpy = mockLogger.error as Spy<any, any[], any>; 
      // Check for the log about failing to retrieve the subscription
      const retrieveErrorLogCall = errorSpy.calls.find(call => String(call.args[0]).includes(`Failed to retrieve Stripe subscription ${stripeSubscriptionId}`));
      assert(retrieveErrorLogCall, `Expected logger error message about failing to retrieve subscription. Logged errors: ${errorSpy.calls.map(c => String(c.args[0])).join("; ")}`);
      
      assertSpyCalls(subscriptionsRetrieveStub, 1);
      assertEquals(subscriptionsRetrieveStub.calls[0].args[0], stripeSubscriptionId);

      // The handler attempts to mark payment_transaction as FAILED
      assertSpyCalls(mockUpdatePaymentTransaction, 1);
      assertEquals(mockUpdatePaymentTransaction.calls[0].args[0], internalPaymentId);
      assertEquals(mockUpdatePaymentTransaction.calls[0].args[1]?.status, "FAILED"); 
      assertEquals(mockUpdatePaymentTransaction.calls[0].args[2], event.id);

      assertSpyCalls(recordTokenTransactionStub, 0); 
    }
  });

  await t.step("handleCheckoutSessionCompleted - subscription - subscription_plans lookup fails", async () => {
    const internalPaymentId = "ptxn_sub_plan_lookup_fails";
    const gatewayTxId = "cs_sub_plan_lookup_fails";
    const stripeSubscriptionId = "sub_plan_lookup_fails_id";
    const userId = "user_sub_plan_lookup_fails";
    const itemId = "item_id_not_in_plans_table"; 
    const stripeCustomerId = "cus_sub_plan_lookup_fails"; // Added customer ID

    const mockPaymentTxData: Partial<PaymentTransaction> = {
      id: internalPaymentId,
      user_id: userId,
      target_wallet_id: "wallet_sub_plan_lookup_fails",
      tokens_to_award: 1000,
      status: "PENDING",
      payment_gateway_id: "stripe",
      metadata_json: { itemId }, 
    };

    const mockStripeSub: Partial<Stripe.Subscription> = {
      id: stripeSubscriptionId, status: 'active', customer: stripeCustomerId,
      items: {
        object: 'list',
        data: [
          {
            id: 'si_mock_item_plan_lookup_fails',
            object: 'subscription_item',
            billing_thresholds: null,
            created: Math.floor(Date.now() / 1000),
            metadata: {},
            plan: { id: 'plan_mock' } as Stripe.Plan,
            price: { id: 'price_xyz', object: 'price', currency: 'usd', recurring: { interval: 'month' } } as Stripe.Price,
            quantity: 1,
            subscription: stripeSubscriptionId,
            tax_rates: [],
            discounts: [],
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 2592000,
          } as unknown as Stripe.SubscriptionItem,
        ],
        has_more: false,
        url: `/v1/subscriptions/${stripeSubscriptionId}/items`,
      },
    };

    setup({ 
      paymentTransaction: mockPaymentTxData,
      stripeSubscriptionRetrieveResult: mockStripeSub, 
      subscriptionPlans: [], 
    });

    const event = createMockCheckoutSessionCompletedEvent({
      id: gatewayTxId,
      mode: "subscription",
      subscription: stripeSubscriptionId,
      customer: stripeCustomerId, // Ensure customer is included
      metadata: { internal_payment_id: internalPaymentId, item_id: itemId },
      client_reference_id: userId,
    });

    const result = await handleCheckoutSessionCompleted(handlerContext, event);

    assert(!result.success, "Expected failure when internal subscription plan lookup fails");
    assertEquals(result.transactionId, internalPaymentId);
    assertEquals(result.paymentGatewayTransactionId, gatewayTxId);
    assert(result.error?.includes(`Could not find internal subscription plan ID for item_id: ${itemId}`), `Unexpected error: ${result.error}`);

    const errorSpy = mockLogger.error as Spy<any, any[], any>; 
    assertSpyCalls(errorSpy, 1);
    const errorLogCall = errorSpy.calls[0].args[0];
    assert(String(errorLogCall).includes(`Could not find internal subscription plan ID for item_id: ${itemId}`), `Unexpected logger error message: ${errorLogCall}`);

    assertSpyCalls(subscriptionsRetrieveStub, 1); 
    
    const subPlansBuilder = mockSupabaseSetup.client.getLatestBuilder('subscription_plans');
    assert(subPlansBuilder, "Subscription plans query builder not used.");
    assertSpyCalls(subPlansBuilder.methodSpies.select, 1);
    assertSpyCalls(subPlansBuilder.methodSpies.eq, 1);
    assertEquals(subPlansBuilder.methodSpies.eq.calls[0].args, ['stripe_price_id', itemId]);

    // Handler also marks payment_transaction FAILED in this case
    assertSpyCalls(mockUpdatePaymentTransaction, 1);
    assertEquals(mockUpdatePaymentTransaction.calls[0].args[1]?.status, "FAILED");

    const userSubBuilder = mockSupabaseSetup.client.getLatestBuilder('user_subscriptions');
    assert(!userSubBuilder?.methodSpies.upsert || userSubBuilder.methodSpies.upsert.calls.length === 0, "user_subscriptions.upsert should not have been called");
    assertSpyCalls(recordTokenTransactionStub, 0);
  });

  await t.step("handleCheckoutSessionCompleted - subscription - user_subscriptions upsert fails", async () => {
    const internalPaymentId = "ptxn_user_sub_upsert_fails";
    const gatewayTxId = "cs_user_sub_upsert_fails";
    const stripeSubscriptionId = "sub_user_sub_upsert_fails_id";
    const userId = "user_sub_upsert_fails";
    const itemId = "item_for_user_sub_upsert_failure";
    const internalPlanId = "plan_for_user_sub_upsert_failure";
    const stripeCustomerId = "cus_user_sub_upsert_fails"; // Added customer ID

    const mockPaymentTxData: Partial<PaymentTransaction> = {
      id: internalPaymentId,
      user_id: userId,
      target_wallet_id: "wallet_user_sub_upsert_fails",
      tokens_to_award: 1000,
      status: "PENDING",
      payment_gateway_id: "stripe",
      metadata_json: { itemId },
    };

    const mockStripeSub: Partial<Stripe.Subscription> = {
      id: stripeSubscriptionId, status: 'active', customer: stripeCustomerId,
      items: {
        object: 'list',
        data: [
          {
            id: 'si_mock_item_upsert_fails',
            object: 'subscription_item',
            billing_thresholds: null,
            created: Math.floor(Date.now() / 1000),
            metadata: {},
            plan: { id: 'plan_mock' } as Stripe.Plan,
            price: { id: 'price_abc' } as Stripe.Price,
            quantity: 1,
            subscription: stripeSubscriptionId,
            tax_rates: [],
            discounts: [],
            current_period_start: Math.floor(Date.now() / 1000),
            current_period_end: Math.floor(Date.now() / 1000) + 2592000,
          } as unknown as Stripe.SubscriptionItem,
        ],
        has_more: false,
        url: `/v1/subscriptions/${stripeSubscriptionId}/items`,
      },
    };
    
    const userSubUpsertErrorMessage = "Mock Supabase: RLS violation or other DB error";
    const userSubUpsertError = new Error(userSubUpsertErrorMessage);

    setup({ 
      paymentTransaction: mockPaymentTxData,
      stripeSubscriptionRetrieveResult: mockStripeSub, 
      subscriptionPlans: [{ id: internalPlanId, item_id_internal: itemId }],
      userSubscriptionUpsertError: userSubUpsertError, 
    });

    const event = createMockCheckoutSessionCompletedEvent({
      id: gatewayTxId,
      mode: "subscription",
      subscription: stripeSubscriptionId,
      customer: stripeCustomerId, // Ensure customer is included
      metadata: { internal_payment_id: internalPaymentId, item_id: itemId },
      client_reference_id: userId,
    });

    const result = await handleCheckoutSessionCompleted(handlerContext, event);

    assert(!result.success, "Expected failure when user_subscriptions upsert fails");
    assertEquals(result.transactionId, internalPaymentId);
    assertEquals(result.paymentGatewayTransactionId, gatewayTxId);
    assert(result.error?.includes(`Failed to upsert user_subscription for ${stripeSubscriptionId}: ${userSubUpsertErrorMessage}`), `Unexpected error: ${result.error}`);
    assertEquals(result.tokensAwarded, 0);


    const errorSpy = mockLogger.error as Spy<any, any[], any>; 
    assertSpyCalls(errorSpy, 1);
    const errorLogCall = errorSpy.calls[0].args[0];
    assert(String(errorLogCall).includes(`Failed to upsert user_subscription for ${stripeSubscriptionId}`), `Unexpected logger error message: ${errorLogCall}`);

    assertSpyCalls(subscriptionsRetrieveStub, 1);
    const subPlansBuilder = mockSupabaseSetup.client.getLatestBuilder('subscription_plans');
    assert(subPlansBuilder?.methodSpies.select?.calls.length === 1, "subscription_plans.select should have been called");
    
    const userSubBuilder = mockSupabaseSetup.client.getLatestBuilder('user_subscriptions');
    assert(userSubBuilder?.methodSpies.upsert?.calls.length === 1, "user_subscriptions.upsert should have been called");

    // Handler marks payment_transaction COMPLETED even if user_sub upsert fails, but returns error for the handler.
    assertSpyCalls(mockUpdatePaymentTransaction, 1);
    assertEquals(mockUpdatePaymentTransaction.calls[0].args[1]?.status, "COMPLETED");

    assertSpyCalls(recordTokenTransactionStub, 0); 
  });

  // TODO: Add more test steps for other scenarios
});

// Test suite for the handleCheckoutSessionCompleted handler directly
Deno.test('handleCheckoutSessionCompleted directly', async (t) => {
  // Mock setup for individual handler tests
  let mockLogger: ILogger;
  let mockStripeInternal: MockStripe; // Renamed to avoid conflict with outer scope mockStripe if Deno.test scopes behave unexpectedly
  let mockSupabaseClientForHandler: SupabaseClient<Database>; 
  let mockTokenWalletServiceForHandler: MockTokenWalletService; // This is the wrapper
  let recordTokenTransactionStub: Stub<ITokenWalletService, Parameters<ITokenWalletService['recordTransaction']>, ReturnType<ITokenWalletService['recordTransaction']>>; // Corrected type for the stub
  let updatePaymentTransactionSpy: Spy<any, any[], any>; // Generic spy type

  const defaultUserIdForHandler = 'user-handler-direct-test';
  // ... existing code ...
});