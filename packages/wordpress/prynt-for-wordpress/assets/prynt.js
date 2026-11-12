/* Prynt for WordPress — front-end. On each protected form it attaches honeypot + timing
 * protection, and at submit time runs identify() with those form signals (plus the comment text
 * for spam analysis), writes the requestId into the hidden field, then lets the form submit so the
 * server can enforce the verdict. Fails OPEN on any error — a Prynt hiccup never blocks a real user. */
(function () {
	'use strict';
	if ( typeof window.Prynt === 'undefined' || ! window.PryntWP || ! window.PryntWP.publicKey ) {
		return;
	}
	var cfg = window.PryntWP;

	function messageText( form ) {
		try {
			var el = form.querySelector( 'textarea[name="comment"], textarea#comment, textarea, input[name="message"]' );
			return el ? String( el.value || '' ) : '';
		} catch ( e ) { return ''; }
	}

	function writeRequestId( form, requestId ) {
		var inputs = form.querySelectorAll( '.prynt-request-id' );
		for ( var j = 0; j < inputs.length; j++ ) {
			inputs[ j ].value = requestId;
		}
	}

	function wire( agent, form ) {
		var guard = agent.protectForm( form );   // injects honeypot + tracks timing/interaction
		var verified = false;
		form.addEventListener( 'submit', function ( ev ) {
			if ( verified ) { return; }             // our own re-submit — let it through
			ev.preventDefault();
			var opts = { formSignals: guard.signals(), tag: { source: 'wordpress' } };
			var text = messageText( form );
			if ( text ) {
				opts.content = cfg.expectedScripts && cfg.expectedScripts.length
					? { text: text, expectedScripts: cfg.expectedScripts }
					: { text: text };
			}
			var done = function ( r ) {
				if ( r && r.requestId ) { writeRequestId( form, r.requestId ); }
				verified = true;
				if ( form.requestSubmit ) { form.requestSubmit(); } else { form.submit(); }
			};
			agent.identify( opts ).then( done ).catch( function () { done( null ); } );
		}, true );
	}

	function run() {
		try {
			window.Prynt.load( { apiKey: cfg.publicKey, endpoint: cfg.endpoint } ).then( function ( agent ) {
				var forms = document.querySelectorAll( 'form' );
				for ( var i = 0; i < forms.length; i++ ) {
					if ( forms[ i ].querySelector( '.prynt-request-id' ) ) {
						wire( agent, forms[ i ] );      // only forms Prynt is set to protect
					}
				}
			} ).catch( function () { /* fail open */ } );
		} catch ( e ) { /* no-op */ }
	}

	if ( document.readyState === 'loading' ) {
		document.addEventListener( 'DOMContentLoaded', run );
	} else {
		run();
	}
})();
