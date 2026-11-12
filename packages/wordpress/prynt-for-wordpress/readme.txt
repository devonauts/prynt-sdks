=== Prynt — Device Intelligence & Fraud Protection ===
Contributors: prynt
Tags: fraud, bot detection, spam protection, device fingerprinting, woocommerce
Requires at least: 5.6
Requires PHP: 7.4
Stable tag: 1.2.0
License: MIT
License URI: https://opensource.org/licenses/MIT

Cloud device intelligence for WordPress. Identify visitors and stop bots & form spam on login,
registration, comments and WooCommerce checkout — verified server-side.

== Description ==
Prynt adds a stable visitor ID plus bot/fraud Smart Signals to your site. The browser agent
identifies each visitor and protects your forms; your server verifies the verdict with your secret
key and can block high-risk, bot or spam submissions. Monitor-only mode logs everything without
blocking anything.

New in 1.1 — Form Shield:
* Honeypot + timing — an invisible decoy field and submit-timing catch scripted form bots.
* Content spam analysis — flags contact/comment spam by links, keyword patterns, and script
  mismatch (Cyrillic/CJK text in a form that expects Latin — the classic Russian/Chinese spam tell).
* Set the expected form language script (default "latin") in settings; leave blank for multilingual sites.

New in 1.2 — Prynt Reveal:
* See which companies visit your website (B2B visitor identification, company level from the network).
* Connect in one step: paste the setup code from the Prynt console (Reveal → quick start → WordPress).
* No DNS record or meta tag: the first visit verifies the website automatically.

Point it at your managed Prynt cloud or your own Prynt API endpoint.

== External services ==

This plugin connects to the Prynt service (Prynt Cloud at https://api.pryntid.com by default, or
the Prynt server you configure under Endpoint) to identify visitors and decide whether a login,
registration, comment or checkout submission is a bot or fraud:

* In the browser (front-end pages and the login page) it loads the Prynt agent from the Prynt
  server, which sends device signals (browser, screen, hardware and storage characteristics), the page URL and
  the visitor's IP address with your public key.
* On form submission, your site sends the request ID it received to the Prynt server with your
  secret key to read the result.

* Reveal (only after you connect it): the Reveal script (prynt-reveal.umd.js) is loaded from the Prynt
  server on front-end pages and sends page views (URL, referrer, title) and the visitor's IP address
  with the website's public key, so Prynt can tell which company network the visit came from. The
  one-time setup code is sent once to the Prynt server to fetch that public key.

Nothing loads or is sent until you save an endpoint and a public key. Prynt terms: https://pryntid.com/terms — privacy
policy: https://pryntid.com/privacy

== Installation ==
1. Upload the plugin ZIP via Plugins → Add New → Upload, or copy the folder to wp-content/plugins.
2. Activate it.
3. Reveal only: in the Prynt console open Reveal → quick start → WordPress, press "Get a setup code", paste it under Prynt → Reveal and press Connect. Done.
4. Device protection: go to the "Prynt" menu, enter your API endpoint, public key and secret key.
5. Choose which forms to protect, set the expected form script, and pick Monitor or Block. Save.

== Frequently Asked Questions ==
= Will it lock users out if the API is down? =
No. Verification fails open — a network/API error never blocks a legitimate submission.

= How does the spam detection work? =
Each protected form gets an invisible honeypot and submit-timing check; comment/contact text is
analyzed for spam links, keywords and unexpected scripts. All of it feeds the server-side verdict.

= Do I need WooCommerce? =
No. WooCommerce checkout protection is optional; login/registration/comments work on any site.

== Changelog ==
= 1.2.0 =
* Prynt Reveal: connect with a one-time setup code (or paste the public key); loads the Reveal script on front-end pages.
* Saving the Device settings keeps the other options.

= 1.1.0 =
* Form Shield: honeypot + timing signals and content spam analysis (Cyrillic/CJK, links, keywords).
* New "Expected form language scripts" setting.

= 1.0.0 =
* Initial release: login/registration/comment/WooCommerce protection with server-side verification.
