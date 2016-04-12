'use strict';
var util = require('util');
var chalk = require('chalk');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');

// Retrieve the flow config from the furnished configuration. It can be:
//  - a dedicated one for the furnished target
//  - a general one
//  - the default one
var getFlowFromConfig = function (config, target) {
  var Flow = require('../lib/flow');
  var flow = new Flow({
    steps: {
      js : ['concat', 'uglify'],
      css: ['concat', 'cssmin']
    },
    post : {}
  });
  if (config.options && config.options.flow) {
    if (config.options.flow[target]) {
      flow.setSteps(config.options.flow[target].steps);
      flow.setPost(config.options.flow[target].post);
    } else {
      flow.setSteps(config.options.flow.steps);
      flow.setPost(config.options.flow.post);
    }
  }
  return flow;
};

//
// Return which locator to use to get the revisioned version (revved) of the files, with, by order of
// preference:
// - a map object passed in option (revmap)
// - a map object produced by grunt-filerev if available
// - a disk lookup
//
var getLocator = function (grunt, options) {
  var locator;
  if (options.revmap) {
    locator = grunt.file.readJSON(options.revmap);
  } else if (grunt.filerev && grunt.filerev.summary) {
    locator = grunt.filerev.summary;
  } else {
    locator = function (p) {
      return grunt.file.expand({
        filter: 'isFile'
      }, p);
    };
  }
  return locator;
};

//
// ### Usemin

// Replaces references to non-optimized scripts or stylesheets
// into a set of HTML files (or any templates/views).
//
// The users markup should be considered the primary source of information
// for paths, references to assets which should be optimized.We also check
// against files present in the relevant directory () (e.g checking against
// the revved filename into the 'temp/') directory to find the SHA
// that was generated.
//
// Todos:
// * Use a file dictionary during build process and rev task to
// store each optimized assets and their associated sha1.
//
// #### Usemin-handler
//
// A special task which uses the build block HTML comments in markup to
// get back the list of files to handle, and initialize the grunt configuration
// appropriately, and automatically.
//
// Custom HTML "block" comments are provided as an API for interacting with the
// build script. These comments adhere to the following pattern:
//
//     <!-- build:<type> <path> -->
//       ... HTML Markup, list of script / link tags.
//     <!-- endbuild -->
//
// - type: is either js or css.
// - path: is the file path of the optimized file, the target output.
//
// An example of this in completed form can be seen below:
//
//    <!-- build:js js/app.js -->
//      <script src="js/app.js"></script>
//      <script src="js/controllers/thing-controller.js"></script>
//      <script src="js/models/thing-model.js"></script>
//      <script src="js/views/thing-view.js"></script>
//    <!-- endbuild -->
//
//
// Internally, the task parses your HTML markup to find each of these blocks, and
// initializes for you the corresponding Grunt config for the concat / uglify tasks
// when `type=js`, the concat / cssmin tasks when `type=css`.
//

module.exports = function (grunt) {
  var FileProcessor = require('../lib/fileprocessor');
  var RevvedFinder = require('../lib/revvedfinder');
  var ConfigWriter = require('../lib/configwriter');
  var _ = require('lodash');

  function md5(filepath, algorithm, encoding) {
    var hash = crypto.createHash(algorithm);
    grunt.log.verbose.write('Hashing ' + filepath + '...');
    hash.update(grunt.file.read(filepath));
    return hash.digest(encoding);
  }

  var revFile = function (fileName) {
    var hash = md5(fileName, 'md5', 'hex'),
      prefix = hash.slice(0, 8),
      renamed = [prefix, path.basename(fileName)].join('.'),
      outPath = path.resolve(path.dirname(fileName), renamed);

    grunt.verbose.ok().ok(hash);
    fs.renameSync(fileName, outPath);

    grunt.log.write(fileName + ' ').ok(renamed);
    return path.dirname(fileName) + "/" + renamed;
  };

  grunt.registerMultiTask('usemin', 'Replaces references to non-minified scripts / stylesheets', function () {
    var debug = require('debug')('usemin:usemin');
    var opts = {}, handlers = {}, revFileMap = {}, revs = this.options()['rev'];

    var revFiles;
    if (revs) {
      revFiles = grunt.file.expand({
        nonull: true,
        filter: 'isFile'
      }, revs);
      revFiles.forEach(function (revFile) {
        revFileMap[revFile] = {revved: false};
      });
    }

    var getHandler = function (target) {
      var options = opts[target] = this.options({
        type: target
      });
      var blockReplacements = options.blockReplacements || {};

      debug('Looking at %s target', target);
      var patterns = [];
      var type = target;

      // Check if we have a user defined pattern
      if (options.patterns && options.patterns[target]) {
        debug('Adding user defined patterns for %s', target);
        patterns = options.patterns[target];
      }

      // var locator = options.revmap ? grunt.file.readJSON(options.revmap) : function (p) { return grunt.file.expand({filter: 'isFile'}, p); };
      var locator = getLocator(grunt, options);
      var revvedfinder = new RevvedFinder(locator);
      var handler = new FileProcessor(type, patterns, revvedfinder, function (msg) {
        grunt.verbose.writeln(msg);
      }, blockReplacements);
      handlers[type] = handler;
      ext2type[type] = type;
    };

    var replaceFile = function (filename, skipThisFile) {
      var suffix = filename.substr(filename.lastIndexOf('.') + 1);
      var type = ext2type[suffix];
      if (!type) {
        grunt.log.subhead('Skip to replace revved-file in file ' + filename);
        return;
      }
      var options = opts[type];
      debug('looking at file %s', filename);

      grunt.verbose.writeln(chalk.bold('Processing as ' + options.type.toUpperCase() + ' - ') + chalk.cyan(filename));

      // Our revved version locator
      var content = handlers[type].process(filename, options.assetsDirs, skipThisFile);

      // write the new content to disk
      grunt.file.write(filename, content);
    };

    var target = this.target, defOpts = this.options(), ext2type = defOpts.ext2type || {};
    if (target == 'files') {
      var dependencies = {};
      for (var type in this.data) {
        getHandler.apply(this, [type]);
        var typeFiles = this.data[type];

        for (var fileIndex in typeFiles) {
          var files = grunt.file.expand({
            nonull: true,
            filter: 'isFile'
          }, typeFiles[fileIndex]);
          files.forEach(function (filename) {
            var suffix = filename.substr(filename.lastIndexOf('.') + 1);
            var type = ext2type[suffix] || suffix;
            var options = opts[type];
            debug('looking at file %s', filename);

            grunt.verbose.writeln(chalk.bold('Processing as ' + options.type.toUpperCase() + ' - ') + chalk.cyan(filename));

            // Our revved version locator
            var fileDeps = handlers[type].scanDependencies(filename, options.assetsDirs);
            dependencies[filename] = fileDeps;
          });
        }
      }
      var fileMap = {}, depsFiles = {};
      for (var fk in dependencies) {
        var mapFile = fileMap[fk];
        if (!mapFile) mapFile = fileMap[fk] = {level: 0};
        var fdeps = dependencies[fk];
        if (!fdeps) continue;

        for (var fr in fdeps) {
          var fdep = fdeps[fr];
          if (fdep && !fdep.src) continue;

          if (fr == fk) {
            mapFile.src = fdep.src;
            continue;
          }

          depsFiles[fr] = true;
          var maprFile = fileMap[fr];
          if (!maprFile) maprFile = fileMap[fr] = {src: fdep.src, level: 0};
          else maprFile.src = fdep.src;
          if (!mapFile.deps)  mapFile.deps = {};
          mapFile.deps[fr] = maprFile;
        }
      }

      var rootFileMap = {};
      _.forEach(fileMap, function (file, fileName) {
        if (!depsFiles[fileName]) {
          rootFileMap[fileName] = true;
        }
      });

      var scanned = {};
      var scan = function (file, scannedFiles, level) {
        for (var fk in file.deps) {
          var mapFile = fileMap[fk], scannedFile = scannedFiles[fk];
          if (!scannedFile) {
            scannedFile = scannedFiles[fk] = {src: mapFile.src, level: level};
          } else {
            scannedFile.level += level;
            scannedFile.src = mapFile.src;
          }

          if (mapFile.deps) {
            scan(mapFile, scannedFiles, level + 1);
          }
        }
      };
      for (var fk in rootFileMap) {
        //var scannedFiles = {};
        //scanned[fk] = scannedFiles;
        var level = 0, mapFile = fileMap[fk], scannedFile = scanned[fk];
        if (!scannedFile) {
          scannedFile = scanned[fk] = {src: mapFile.src, level: level};
        } else {
          level = scannedFile.level;
        }

        if (mapFile.deps) {
          scan(mapFile, scanned, level + 1);
        }
      }

      var maxedLevelFiles = {}, levelMap = {}, levels = [];
      _.forEach(scanned, function (file, fileName) {
        //_.forEach(scannedFiles, function (file, fileName) {
        var mapFile = maxedLevelFiles[fileName];
        if (!mapFile) {
          maxedLevelFiles[fileName] = {src: file.src, level: file.level};
        } else {
          mapFile.level = Math.max(mapFile.level, file.level);
        }
        //});
      });

      _.forEach(maxedLevelFiles, function (mapFile, fileName) {
        var levelFiles = levelMap[mapFile.level];
        if (!levelFiles) {
          levelFiles = levelMap[mapFile.level] = {};
          levels.push(mapFile.level);
        }
        levelFiles[fileName] = mapFile;
      });

      //console.log(JSON.stringify(levelMap));
      var maxLevel = -1;
      levels = _.sortBy(levels, function (n) {
        maxLevel = Math.max(maxLevel, n);
        return -n;
      });

      var revedFileMap = {};
      _.forEach(levels, function (level) {
        var levelFiles = levelMap[level];
        if (maxLevel == level) {
          _.forEach(levelFiles, function (file, fileName) {
            var revedFile;
            if (revFileMap[file.src]) {
              revedFile = revFile(fileName);
              revFileMap[file.src].revved = true;
            } else {
              revedFile = fileName;
            }
            revedFileMap[fileName] = revedFile;
            replaceFile(revedFile);
          });
        } else {
          _.forEach(levelFiles, function (file, fileName) {// reloace requires
            replaceFile(fileName, true);
          });
          _.forEach(levelFiles, function (file, fileName) {
            var revedFile;
            if (revFileMap[file.src]) {
              revedFile = revFile(fileName);
              revFileMap[file.src].revved = true;
            } else {
              revedFile = fileName;
            }
            revedFileMap[fileName] = revedFile;
            replaceFile(revedFile);
          });
        }
      });

      grunt.log.subhead('Start rev no deps files');
      _.forEach(revFileMap, function (file, fileName) {
        if (file.revved === false) {
          revFile(fileName);
          file.revved = true;
        }
      });
      grunt.log.subhead('Finish rev no deps files');
    } else {
      getHandler.apply(this, [target]);

      this.files.forEach(function (fileObj) {
        var files = grunt.file.expand({
          nonull: true,
          filter: 'isFile'
        }, fileObj.src);
        files.forEach(function (filename) {
          replaceFile(filename);
        });
        grunt.log.writeln('Replaced ' + chalk.cyan(files.length) + ' ' +
          (files.length === 1 ? 'reference' : 'references') + ' to assets'
        );
      });
    }
  });

  grunt.registerMultiTask('useminPrepare', 'Using HTML markup as the primary source of information', function () {
    var options = this.options();
    // collect files
    var dest = options.dest || 'dist';
    var staging = options.staging || '.tmp';
    var root = options.root;

    grunt.verbose
      .writeln('Going through ' + grunt.log.wordlist(this.filesSrc) + ' to update the config')
      .writeln('Looking for build script HTML comment blocks');

    var flow = getFlowFromConfig(grunt.config('useminPrepare'), this.target);

    var c = new ConfigWriter(flow, {
      root   : root,
      dest   : dest,
      staging: staging
    });

    var cfgNames = [];
    c.stepWriters().forEach(function (i) {
      cfgNames.push(i.name);
    });
    c.postWriters().forEach(function (i) {
      cfgNames.push(i.name);
    });
    var gruntConfig = {};
    _.forEach(cfgNames, function (name) {
      gruntConfig[name] = grunt.config(name) || {};
    });

    this.filesSrc.forEach(function (filepath) {
      var config;
      try {
        config = c.process(filepath, grunt.config());
      } catch (e) {
        grunt.fail.warn(e);
      }

      _.forEach(cfgNames, function (name) {
        gruntConfig[name] = grunt.config(name) || {};
        grunt.config(name, _.assign(gruntConfig[name], config[name]));
      });

    });

    // log a bit what was added to config
    grunt.verbose.subhead('Configuration is now:');
    _.forEach(cfgNames, function (name) {
      grunt.verbose.subhead('  ' + name + ':')
        .writeln('  ' + util.inspect(grunt.config(name), false, 4, true, true));
    });

    // only displayed if not in verbose mode
    grunt.verbose.or.writeln('Configuration changed for', grunt.log.wordlist(cfgNames));
  });
};
