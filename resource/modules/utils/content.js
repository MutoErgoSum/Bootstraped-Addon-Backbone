// VERSION = '1.5.1';

// This script should be loaded by defaultsContent.js, which is in turn loaded directly by the Messenger module.
// defaultsContent.js should set this object's objName and objPathString properties and call its .init() method.
// This helps with defining a "separate" environment in the content script, while remaining accessible to the rest of the content scope.
//
// Use the Messenger object to send message safely to this object without conflicting with other add-ons.
// To load or unload modules in the modules/content/ folder into this object, use Messenger's loadIn* methods.
// Reserved messages for the Messenger system: load, unload, init, reinit, pref, shutdown
//
// Methods that can be used inside content modules:
// listen(aMessage, aListener) - adds aListener as a receiver for when aMessage is passed from chrome to content through the Messenger object.
//	aMessage - (string) message to listen to
//	aListener - (function) the listener that will respond to the message. Expects (message) as its only argument; see https://developer.mozilla.org/en-US/docs/The_message_manager
// unlisten(aMessage, aListener) - stops aListener from responding to aMessage.
//	see listen()
// message(aMessage, aListener) - sends a message to chrome to be handled through Messenger
//	see listen()
// handleDeadObject(ex) - 	expects [nsIScriptError object] ex. Shows dead object notices as warnings only in the console.
//				If the code can handle them accordingly and firefox does its thing, they shouldn't cause any problems.
//				This should be a copy of the same method in bootstrap.js.
// DOMContentLoaded.add(aMethod) - use this to listen to DOMContentLoaded events, instead of adding a dedicated listener to Scope, to avoid a very weird ZC
//	aMethod - (function) normal event listener or (object) a object containing a .onDOMContentLoaded method; both expect aEvent as its single parameter
// DOMContentLoaded.remove(aMethod) - undo the above step
//	see DOMContentLoaded.add

this.Cc = Components.classes;
this.Ci = Components.interfaces;
this.Cu = Components.utils;
this.Cm = Components.manager;

this.__contentEnvironment = {
	objName: '',
	objPathString: '',
	
	addonUris: {
		homepage: '',
		support: '',
		fullchangelog: '',
		email: '',
		profile: '',
		api: '',
		development: ''
	},
	
	initialized: false,
	listeners: new Set(),
	_queued: new Set(),
	
	isContent: true,
	Scope: this, // to delete our variable on shutdown later
	get document () { return content.document; },
	$: function(id) { return content.document.getElementById(id); },
	$$: function(sel, parent = content.document) { return parent.querySelectorAll(sel); },
	$�: function(parent, anonid, anonattr = 'anonid') { return content.document.getAnonymousElementByAttribute(parent, anonattr, anonid); },
	
	// easy and useful helpers for when I'm debugging
	LOG: function(str) {
		if(!str) { str = typeof(str)+': '+str; }
		this.console.log(this.objName+' :: CONTENT :: '+str);
	},
	
	// some local things
	AddonData: {},
	Globals: {},
	Prefs: {},
	
	WINNT: false,
	DARWIN: false,
	LINUX: false,
	
	// and some global (content) things
	webProgress: null,
	
	// implement message listeners
	MESSAGES: [
		'shutdown',
		'load',
		'unload',
		'loadQueued',
		'pref',
		'init',
		'reinit'
	],
	
	messageName: function(m) {
		// +1 is for the ':' after objName
		return m.name.substr(this.objName.length +1);
	},
	
	receiveMessage: function(m) {
		let name = this.messageName(m);
		
		switch(name) {
			case 'shutdown':
				// when updating the add-on, the new content script is loaded before the shutdown message is received by the previous script (go figure...),
				// so we'd actually be unloading both the old and new scripts, that's obviously not what we want!
				if(this.AddonData.initTime) {
					this.unload();
				}
				break;
				
			case 'load':
				this.loadModule(m.data);
				break;
				
			case 'unload':
				this.unloadModule(m.data);
				break;
				
			case 'loadQueued':
				this.loadQueued();
				break;
			
			case 'pref':
				this.carriedPref(m.data);
				break;
			
			case 'init':
				this.finishInit(m.data);
				break;
			
			case 'reinit':
				this.reinit();
				break;
		}
	},
	
	init: function() {
		this.WINNT = Services.appinfo.OS == 'WINNT';
		this.DARWIN = Services.appinfo.OS == 'Darwin';
		this.LINUX = Services.appinfo.OS != 'WINNT' && Services.appinfo.OS != 'Darwin';
		
		// AddonManager can't be used in child processes!
		XPCOMUtils.defineLazyModuleGetter(this, "console", "resource://gre/modules/devtools/Console.jsm");
		XPCOMUtils.defineLazyModuleGetter(this.Scope, "PluralForm", "resource://gre/modules/PluralForm.jsm");
		XPCOMUtils.defineLazyModuleGetter(this.Scope, "Promise", "resource://gre/modules/Promise.jsm");
		XPCOMUtils.defineLazyModuleGetter(this.Scope, "Task", "resource://gre/modules/Task.jsm");
		XPCOMUtils.defineLazyServiceGetter(Services, "navigator", "@mozilla.org/network/protocol;1?name=http", "nsIHttpProtocolHandler");
		
		this.webProgress = docShell.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIWebProgress);
		
		this.Scope.addEventListener('DOMContentLoaded', this.DOMContentLoaded);
		
		// and finally our add-on stuff begins
		Services.scriptloader.loadSubScript("resource://"+this.objPathString+"/modules/utils/Modules.jsm", this);
		Services.scriptloader.loadSubScript("resource://"+this.objPathString+"/modules/utils/sandboxUtilsPreload.jsm", this);
		Services.scriptloader.loadSubScript("resource://"+this.objPathString+"/modules/utils/windowUtilsPreload.jsm", this);
		
		for(let msg of this.MESSAGES) {
			this.listen(msg, this);
		}
		this.message('init');
	},
	
	finishInit: function(data) {
		this.AddonData = data.AddonData;
		this.addonUris = data.addonUris;
		this.initialized = true;
	},
	
	reinit: function() {
		if(!this.initialized) {
			this.message('init');
		}
	},
	
	listen: function(aMessage, aListener) {
		for(let l of this.listeners) {
			if(l.message == aMessage && l.listener == aListener) { return; }
		}
		
		this.listeners.add({ message: aMessage, listener: aListener });
		addMessageListener(this.objName+':'+aMessage, aListener);
	},
	
	unlisten: function(aMessage, aListener) {
		for(let l of this.listeners) {
			if(l.message == aMessage && l.listener == aListener) {
				removeMessageListener(this.objName+':'+aMessage, aListener);
				this.listeners.delete(l);
				return;
			}
		}
	},
	
	// send a message to chrome
	message: function(aMessage, aData, aCPOW) {
		// prevents console messages on e10s closing windows (i.e. view-source), there's no point in sending messages from here if "here" doesn't exist anymore
		if(!content) { return; }
		
		sendAsyncMessage(this.objName+':'+aMessage, aData, aCPOW);
	},
	
	loadModule: function(name) {
		// prevents console messages on e10s startup if this is loaded onto the initial temporary browser, which is almost immediately removed afterwards
		if(!content) { return; }
		
		if(this.initialized) {
			this.Modules.load('content/'+name);
		} else if(!this._queued.has(name)) {
			this._queued.add(name);
		}
	},
	
	unloadModule: function(name) {
		// prevents console messages on e10s closing windows (i.e. view-source), there's no point in unloading anything in-content if the content doesn't exist after all
		if(!content) { return; }
		
		if(this._queued.has(name)) {
			this._queued.delete(name);
		}
		this.Modules.unload('content/'+name);
	},
	
	loadQueued: function() {
		// finish loading the modules that were waiting for content to be fully initialized
		for(let module of this._queued) {
			this.Modules.load('content/'+module);
		}
		this._queued = new Set();
	},
	
	// we can't access AddonManager (thus FUEL) from content processes, so we simulate it, by syncing this object to the sandbox's Prefs (chrome -> content, one way only)
	carriedPref: function(prefs) {
		for(let pref in prefs) {
			this.Prefs[pref] = prefs[pref];
		}
	},
	
	// ZC is we add multiple listeners to Scope for DOMContentLoad, no clue why though...
	DOMContentLoaded: {
		handlers: [],
		add: function(aMethod) {
			for(var h of this.handlers) {
				if(h == aMethod) { return; }
			}
			
			this.handlers.push(aMethod);
		},
		remove: function(aMethod) {
			for(var h in this.handlers) {
				if(this.handlers[h] == aMethod) {
					this.handlers.splice(h, 1);
					return;
				}
			}
		},
		handleEvent: function(e) {
			for(let h of this.handlers) {
				try {
					if(typeof(h.onDOMContentLoaded) == 'function') {
						h.onDOMContentLoaded(e);
					} else {
						h(e);
					}
				}
				catch(ex) { Cu.reportError(ex); }
			}
		}
	},
	
	handleDeadObject: function(ex) {
		if(ex.message == "can't access dead object") {
			var scriptError = Cc["@mozilla.org/scripterror;1"].createInstance(Ci.nsIScriptError);
			scriptError.init("Can't access dead object. This shouldn't cause any problems.", ex.sourceName || ex.fileName || null, ex.sourceLine || null, ex.lineNumber || null, ex.columnNumber || null, scriptError.warningFlag, 'XPConnect JavaScript');
			Services.console.logMessage(scriptError);
			return true;
		} else {
			Cu.reportError(ex);
			return false;
		}
	},
	
	// clean up this object
	unload: function() {
		try {
			this.Modules.clean();
		}
		catch(ex) { Cu.reportError(ex); }
		
		this.Scope.removeEventListener('DOMContentLoaded', this.DOMContentLoaded);
		
		// remove all listeners, to make sure nothing is left over
		for(let l of this.listeners) {
			removeMessageListener(this.objName+':'+l.message, l.listener);
		}
		
		delete this.Scope[this.objName];
	}
};
