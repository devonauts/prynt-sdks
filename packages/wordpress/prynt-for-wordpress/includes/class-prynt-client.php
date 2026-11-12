<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

/**
 * Thin API client. Verifies an identification by requestId, server-side, with the secret key —
 * so the browser can't forge a verdict. Uses WP HTTP (no external dependency).
 */
class Prynt_Client {

	/**
	 * Fetch the trusted decision for a requestId. Returns an array or WP_Error.
	 * Result: [ 'decision' => allow|challenge|block, 'riskScore' => int, 'bot' => bool,
	 *           'visitorId' => string, 'smartSignals' => array ]
	 */
	public static function verify( $request_id ) {
		$s = prynt_get_settings();
		if ( empty( $s['endpoint'] ) || empty( $s['secret_key'] ) || empty( $request_id ) ) {
			return new WP_Error( 'prynt_unconfigured', 'Missing endpoint, secret key, or requestId' );
		}
		$url = trailingslashit( $s['endpoint'] ) . 'v1/events/' . rawurlencode( $request_id );
		$res = wp_remote_get( $url, array(
			'timeout' => 4,
			'user-agent' => 'prynt-wordpress/' . PRYNT_VERSION,
			'headers' => array( 'Authorization' => 'Bearer ' . $s['secret_key'], 'X-Prynt-SDK' => 'wordpress/' . PRYNT_VERSION ),
		) );
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$code = wp_remote_retrieve_response_code( $res );
		$body = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( 200 !== (int) $code || ! is_array( $body ) ) {
			return new WP_Error( 'prynt_verify_failed', 'Verify failed (HTTP ' . $code . ')' );
		}
		$signals = isset( $body['smartSignals'] ) && is_array( $body['smartSignals'] ) ? $body['smartSignals'] : array();
		return array(
			'decision'     => isset( $body['decision'] ) ? $body['decision'] : 'allow',
			'riskScore'    => isset( $body['riskScore'] ) ? (int) $body['riskScore'] : 0,
			'bot'          => ! empty( $signals['bot']['result'] ),
			'visitorId'    => isset( $body['visitorId'] ) ? $body['visitorId'] : '',
			'smartSignals' => $signals,
		);
	}

	/**
	 * Decide whether to block, given settings + a verify() result. Fail-open: a verify error
	 * NEVER locks a legitimate user out of the site.
	 */
	public static function should_block( $verify ) {
		if ( is_wp_error( $verify ) || ! is_array( $verify ) ) {
			return false; // fail open
		}
		$s = prynt_get_settings();
		if ( 'block' !== $s['mode'] ) {
			return false; // monitor mode never blocks
		}
		if ( 'block' === $verify['decision'] || $verify['bot'] ) {
			return true;
		}
		return $verify['riskScore'] >= (int) $s['block_score'];
	}

	/** Keep a small rolling log of recent decisions for the admin dashboard. */
	public static function log( $context, $verify ) {
		if ( is_wp_error( $verify ) ) {
			return;
		}
		$log = get_option( 'prynt_recent', array() );
		array_unshift( $log, array(
			'time'      => time(),
			'context'   => $context,
			'decision'  => isset( $verify['decision'] ) ? $verify['decision'] : 'allow',
			'riskScore' => isset( $verify['riskScore'] ) ? (int) $verify['riskScore'] : 0,
			'bot'       => ! empty( $verify['bot'] ),
			'visitorId' => isset( $verify['visitorId'] ) ? $verify['visitorId'] : '',
		) );
		update_option( 'prynt_recent', array_slice( $log, 0, 50 ), false );
	}
}
