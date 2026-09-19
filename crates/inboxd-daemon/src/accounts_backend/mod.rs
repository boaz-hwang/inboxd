//! Account policy and state. Provider processes only execute explicit SDK primitives.
use serde_json::Value;
use std::future::Future;

pub(crate) mod contract;
mod kakao;
pub(crate) mod pagination;
mod slack;
pub(crate) mod storage_keys;
mod telegram;

pub(crate) trait ProviderIo {
    fn call(&mut self, request: Value) -> impl Future<Output = Result<Value, String>> + Send;
}

pub(crate) struct AccountBackend(Backend);
enum Backend {
    Slack(slack::SlackBackend),
    Kakao(kakao::KakaoBackend),
    Telegram(telegram::TelegramBackend),
    Unsupported,
}
impl AccountBackend {
    pub(crate) fn new(platform: &str) -> Self {
        Self(match platform {
            "slack" => Backend::Slack(Default::default()),
            "kakao" => Backend::Kakao(Default::default()),
            "telegram" => Backend::Telegram(Default::default()),
            _ => Backend::Unsupported,
        })
    }
    /// New job state shares only immutable, scoped search continuations. Large
    /// mutable provider caches move between jobs and are never deep-cloned.
    pub(crate) fn fork(&self) -> Self {
        Self(match &self.0 {
            Backend::Kakao(state) => Backend::Kakao(state.fork()),
            Backend::Slack(_) => Backend::Slack(Default::default()),
            Backend::Telegram(_) => Backend::Telegram(Default::default()),
            Backend::Unsupported => Backend::Unsupported,
        })
    }
    pub(crate) async fn run(
        &mut self,
        request: &Value,
        io: &mut impl ProviderIo,
    ) -> Result<Value, String> {
        match &mut self.0 {
            Backend::Slack(state) => state.run(request, io).await,
            Backend::Kakao(state) => state.run(request, io).await,
            Backend::Telegram(state) => state.run(request, io).await,
            Backend::Unsupported => Err("지원하지 않는 계정".into()),
        }
    }
}
