use soroban_sdk::{contracttype, symbol_short, Address, Env, Symbol};

/// Default grace period: 1 day in seconds.
pub const GRACE_PERIOD_SECS: u64 = 86_400;
/// Maximum configurable grace period: 3 days in seconds.
pub const MAX_GRACE_PERIOD_SECS: u64 = 259_200;

pub const SUBSCRIPTION: Symbol = symbol_short!("SUBSCRIPTION");
pub const GRACE_CANCEL: Symbol = symbol_short!("GRACE_CANCEL");

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    pub subscriber: Address,
    pub merchant: Address,
    pub amount: i128,
    pub active: bool,
    pub last_charge_at: u64,
    pub grace_period_ends_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Plan {
    pub merchant: Address,
    pub amount: i128,
    /// Grace period in seconds, constrained to `[0, MAX_GRACE_PERIOD_SECS]`.
    pub grace_period_secs: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SubscriptionError {
    NotFound,
    NotSubscriber,
    GracePeriodClosed,
    GracePeriodOutOfRange,
}

/// Charge an active subscription and open a fresh cancellation grace window.
pub fn charge_subscription(env: &Env, subscription_id: u64) -> Result<(), SubscriptionError> {
    let mut subscription = load_subscription(env, subscription_id)?;
    let now = env.ledger().timestamp();

    // Process the charge (payment transfer handled by the billing module).
    subscription.last_charge_at = now;
    subscription.grace_period_ends_at = now + GRACE_PERIOD_SECS;

    save_subscription(env, subscription_id, &subscription);
    Ok(())
}

/// Cancel a subscription within the grace period and refund the most recent charge.
///
/// The caller must be the subscriber and the grace window must still be open.
/// The refund is issued atomically with the cancellation.
pub fn cancel_within_grace_period(
    env: &Env,
    subscription_id: u64,
    caller: Address,
) -> Result<(), SubscriptionError> {
    caller.require_auth();

    let mut subscription = load_subscription(env, subscription_id)?;

    if subscription.subscriber != caller {
        return Err(SubscriptionError::NotSubscriber);
    }

    let now = env.ledger().timestamp();
    if now > subscription.grace_period_ends_at {
        return Err(SubscriptionError::GracePeriodClosed);
    }

    // Cancel and refund the most recent charge atomically.
    subscription.active = false;
    save_subscription(env, subscription_id, &subscription);
    refund_charge(env, &subscription);

    env.events().publish(
        (SUBSCRIPTION, GRACE_CANCEL),
        (subscription_id, subscription.subscriber.clone(), subscription.amount),
    );

    Ok(())
}

/// Cancel a subscription outside the grace period. No refund is issued.
pub fn cancel_subscription(
    env: &Env,
    subscription_id: u64,
    caller: Address,
) -> Result<(), SubscriptionError> {
    caller.require_auth();

    let mut subscription = load_subscription(env, subscription_id)?;
    if subscription.subscriber != caller {
        return Err(SubscriptionError::NotSubscriber);
    }

    subscription.active = false;
    save_subscription(env, subscription_id, &subscription);
    Ok(())
}

/// Validate and normalize a merchant-configured grace period.
pub fn validate_grace_period(grace_period_secs: u64) -> Result<u64, SubscriptionError> {
    if grace_period_secs > MAX_GRACE_PERIOD_SECS {
        return Err(SubscriptionError::GracePeriodOutOfRange);
    }
    Ok(grace_period_secs)
}

fn load_subscription(env: &Env, subscription_id: u64) -> Result<Subscription, SubscriptionError> {
    env.storage()
        .persistent()
        .get(&subscription_id)
        .ok_or(SubscriptionError::NotFound)
}

fn save_subscription(env: &Env, subscription_id: u64, subscription: &Subscription) {
    env.storage().persistent().set(&subscription_id, subscription);
}

fn refund_charge(env: &Env, subscription: &Subscription) {
    // Refund transfer is executed by the payments module; the subscription
    // module records the refund intent for the most recent charge.
    env.storage().persistent().set(
        &(symbol_short!("REFUND"), subscription.subscriber.clone()),
        &subscription.amount,
    );
}
