(function () {
  if (window.QRCode || typeof window.qrcode !== 'function') return;

  window.QRCode = {
    toCanvas: function (canvas, text, options, callback) {
      try {
        var size = Math.max(120, Number(options && options.width) || 260);
        var margin = Math.max(0, Number(options && options.margin) || 2);
        var dark = (options && options.color && options.color.dark) || '#000';
        var light = (options && options.color && options.color.light) || '#fff';
        var qr = window.qrcode(0, 'M');
        qr.addData(String(text || ''));
        qr.make();

        var count = qr.getModuleCount();
        var quiet = margin;
        var total = count + quiet * 2;
        var cell = Math.floor(size / total);
        var canvasSize = cell * total;
        var ctx = canvas.getContext('2d');

        canvas.width = canvasSize;
        canvas.height = canvasSize;
        ctx.fillStyle = light;
        ctx.fillRect(0, 0, canvasSize, canvasSize);
        ctx.fillStyle = dark;

        for (var row = 0; row < count; row++) {
          for (var col = 0; col < count; col++) {
            if (qr.isDark(row, col)) {
              ctx.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
            }
          }
        }

        if (callback) callback(null);
      } catch (error) {
        if (callback) callback(error);
      }
    }
  };
})();
