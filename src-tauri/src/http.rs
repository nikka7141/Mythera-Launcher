//! Backend HTTP client (reqwest). `api_json` is the unauthenticated call; `authed_json` attaches the
//! stored access token and transparently refreshes it on 401 — a 1:1 port of the Electron apiJson/
//! authedJson helpers. Plus small download/get_json helpers reused by sync/jre/install.

use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::{self, Session};
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::path::Path;

async fn parse<T: DeserializeOwned>(res: reqwest::Response) -> AppResult<T> {
    let status = res.status();
    let text = res.text().await?;
    let body: Value = if text.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text)?
    };
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Request failed ({})", status.as_u16()));
        return Err(AppError::msg(msg));
    }
    Ok(serde_json::from_value(body)?)
}

/// Unauthenticated JSON call: `${api_base}${path}` with optional JSON body.
pub async fn api_json<T: DeserializeOwned>(
    st: &AppState,
    path: &str,
    method: Method,
    body: Option<Value>,
) -> AppResult<T> {
    let url = format!("{}{}", st.api_base, path);
    let mut req = st.http.request(method, url).header("Content-Type", "application/json");
    if let Some(b) = body {
        req = req.json(&b);
    }
    parse(req.send().await?).await
}

/// Authenticated JSON call: attaches the access token, refreshes it once on 401, retries.
pub async fn authed_json<T: DeserializeOwned>(
    st: &AppState,
    path: &str,
    method: Method,
    body: Option<Value>,
) -> AppResult<T> {
    let session = store::load().ok_or_else(|| AppError::msg("Not logged in"))?;
    let url = format!("{}{}", st.api_base, path);

    let build = |token: &str| {
        let mut req = st
            .http
            .request(method.clone(), url.as_str())
            .header("Content-Type", "application/json")
            .bearer_auth(token);
        if let Some(b) = &body {
            req = req.json(b);
        }
        req
    };

    let mut res = build(&session.access_token).send().await?;
    if res.status() == StatusCode::UNAUTHORIZED {
        // Try a refresh; on failure clear the session and surface "log in again".
        let refresh_url = format!("{}/auth/refresh", st.api_base);
        let r = st
            .http
            .post(refresh_url)
            .json(&serde_json::json!({ "refreshToken": session.refresh_token }))
            .send()
            .await?;
        if !r.status().is_success() {
            store::clear();
            return Err(AppError::msg("Session expired — please log in again."));
        }
        let data: Value = r.json().await?;
        let access = data.get("accessToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let refresh = data.get("refreshToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let user = data.get("user").cloned().unwrap_or(session.user.clone());
        store::save(&Session { access_token: access.clone(), refresh_token: refresh, user })?;
        res = build(&access).send().await?;
    }
    parse(res).await
}

/// Authenticated multipart upload of a single file field. Mirrors `authed_json`'s token-load +
/// one-shot 401 refresh, but sends `multipart/form-data` (the form is rebuilt per attempt).
pub async fn authed_upload(
    st: &AppState,
    path: &str,
    field: &str,
    bytes: Vec<u8>,
    filename: &str,
    mime: &str,
) -> AppResult<Value> {
    let session = store::load().ok_or_else(|| AppError::msg("Not logged in"))?;
    let url = format!("{}{}", st.api_base, path);

    let build = |token: &str| -> AppResult<reqwest::RequestBuilder> {
        let part = reqwest::multipart::Part::bytes(bytes.clone())
            .file_name(filename.to_string())
            .mime_str(mime)
            .map_err(|e| AppError::msg(format!("multipart: {e}")))?;
        let form = reqwest::multipart::Form::new().part(field.to_string(), part);
        Ok(st.http.post(url.as_str()).bearer_auth(token).multipart(form))
    };

    let mut res = build(&session.access_token)?.send().await?;
    if res.status() == StatusCode::UNAUTHORIZED {
        let refresh_url = format!("{}/auth/refresh", st.api_base);
        let r = st
            .http
            .post(refresh_url)
            .json(&serde_json::json!({ "refreshToken": session.refresh_token }))
            .send()
            .await?;
        if !r.status().is_success() {
            store::clear();
            return Err(AppError::msg("Session expired — please log in again."));
        }
        let data: Value = r.json().await?;
        let access = data.get("accessToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let refresh = data.get("refreshToken").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let user = data.get("user").cloned().unwrap_or(session.user.clone());
        store::save(&Session { access_token: access.clone(), refresh_token: refresh, user })?;
        res = build(&access)?.send().await?;
    }
    parse(res).await
}

/// GET + parse JSON (no auth). Used by the Mojang/Forge/Adoptium fetchers.
pub async fn get_json<T: DeserializeOwned>(http: &reqwest::Client, url: &str) -> AppResult<T> {
    let res = http.get(url).send().await?;
    if !res.status().is_success() {
        return Err(AppError::msg(format!("GET {} {}", res.status().as_u16(), url)));
    }
    Ok(res.json().await?)
}

/// Download `url`, write it to `dest` (creating parents), and also return the bytes.
pub async fn download(http: &reqwest::Client, url: &str, dest: &Path) -> AppResult<Vec<u8>> {
    let res = http.get(url).send().await?;
    if !res.status().is_success() {
        return Err(AppError::msg(format!("GET {} {}", res.status().as_u16(), url)));
    }
    let bytes = res.bytes().await?.to_vec();
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(dest, &bytes).await?;
    Ok(bytes)
}

/// Fetch raw bytes without writing to disk.
pub async fn get_bytes(http: &reqwest::Client, url: &str) -> AppResult<Vec<u8>> {
    let res = http.get(url).send().await?;
    if !res.status().is_success() {
        return Err(AppError::msg(format!("GET {} {}", res.status().as_u16(), url)));
    }
    Ok(res.bytes().await?.to_vec())
}
