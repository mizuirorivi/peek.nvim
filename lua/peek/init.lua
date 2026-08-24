local app = require('peek.app')
local config = require('peek.config')
local throttle = require('peek.throttle')

local nvim_buf_get_lines = vim.api.nvim_buf_get_lines
local nvim_create_augroup = vim.api.nvim_create_augroup
local nvim_create_autocmd = vim.api.nvim_create_autocmd
local nvim_del_augroup_by_id = vim.api.nvim_del_augroup_by_id
local concat = table.concat
local line = vim.fn.line

local module = {}

local augroup, throttle_at, throttle_time, initialized, previewed_bufnr, previewed_winid, preview_id, preview_key
local preview_version, restarting, show_throttled, last_tabs_signature, tabs_scheduled
local sent_versions = {}
local sent_version_order = {}
local max_sent_versions = 32

local function remember_sent_version(document_key, version)
  sent_versions[document_key] = version
  for index, key in ipairs(sent_version_order) do
    if key == document_key then
      table.remove(sent_version_order, index)
      break
    end
  end
  table.insert(sent_version_order, document_key)
  while #sent_version_order > max_sent_versions do
    sent_versions[table.remove(sent_version_order, 1)] = nil
  end
end

local function get_buf_content(bufnr)
  return concat(nvim_buf_get_lines(bufnr, 0, -1, false), '\n'):gsub('%s*$', '')
end

local function get_document_key(bufnr)
  return tostring(bufnr) .. ':' .. vim.api.nvim_buf_get_name(bufnr)
end

local function get_preview_line()
  if
    previewed_winid
    and vim.api.nvim_win_is_valid(previewed_winid)
    and vim.api.nvim_win_get_buf(previewed_winid) == previewed_bufnr
  then
    return vim.api.nvim_win_get_cursor(previewed_winid)[1]
  end

  if previewed_bufnr and vim.api.nvim_buf_is_valid(previewed_bufnr) then
    local winid = vim.fn.win_findbuf(previewed_bufnr)[1]
    if winid and vim.api.nvim_win_is_valid(winid) then
      previewed_winid = winid
      return vim.api.nvim_win_get_cursor(winid)[1]
    end
    local info = vim.fn.getbufinfo(previewed_bufnr)[1]
    if info and info.lnum then
      return info.lnum
    end
  end

  return line('.')
end

local function send_preview_scroll()
  if not preview_id or not preview_key or preview_version == nil then
    return
  end
  app.scroll(preview_id, preview_key, preview_version, get_preview_line())
end

local function get_preview_tabs()
  local current_tabpage = vim.api.nvim_get_current_tabpage()
  local tabs = {}
  local signature = {}

  for _, tabpage in ipairs(vim.api.nvim_list_tabpages()) do
    if vim.api.nvim_tabpage_is_valid(tabpage) then
      local winid = vim.api.nvim_tabpage_get_win(tabpage)
      local bufnr = vim.api.nvim_win_get_buf(winid)
      if vim.tbl_contains(config.get('filetype'), vim.bo[bufnr].filetype) then
        local path = vim.api.nvim_buf_get_name(bufnr)
        table.insert(tabs, {
          id = tabpage,
          path = path,
          label = path == '' and '[No Name]' or vim.fn.fnamemodify(path, ':t'),
          active = tabpage == current_tabpage,
        })
        table.insert(
          signature,
          concat({
            tostring(tabpage),
            tostring(bufnr),
            path,
            tabpage == current_tabpage and '1' or '0',
          }, '\0')
        )
      end
    end
  end

  return tabs, concat(signature, '\0\0')
end

local function send_tabs(force)
  if not augroup or not app.tabs or not config.get('useful_web') then
    return
  end

  local tabs, signature = get_preview_tabs()
  if force or signature ~= last_tabs_signature then
    last_tabs_signature = signature
    app.tabs(tabs)
  end
end

local function schedule_tabs()
  if tabs_scheduled then
    return
  end
  tabs_scheduled = true
  vim.schedule(function()
    tabs_scheduled = false
    send_tabs()
  end)
end

local function send_preview_content(document_id, document_key, version, force)
  if
    document_id ~= preview_id
    or document_key ~= preview_key
    or not previewed_bufnr
    or not vim.api.nvim_buf_is_valid(previewed_bufnr)
  then
    return
  end

  local current_version = vim.api.nvim_buf_get_changedtick(previewed_bufnr)
  if version ~= nil and version ~= current_version then
    return
  end
  if not force and sent_versions[document_key] == current_version then
    return
  end

  preview_version = current_version
  remember_sent_version(document_key, current_version)
  app.show(document_id, document_key, current_version, get_buf_content(previewed_bufnr))
  send_preview_scroll()
end

local function open(bufnr)
  if show_throttled then
    show_throttled:clear()
    show_throttled = nil
  end

  previewed_bufnr = bufnr
  previewed_winid = vim.api.nvim_get_current_win()
  preview_id = (preview_id or 0) + 1
  preview_key = get_document_key(bufnr)
  preview_version = vim.api.nvim_buf_get_changedtick(bufnr)
  augroup = nvim_create_augroup('PeekActiveAugroup', { clear = true })

  local on_open_file, on_listdir
  if config.get('useful_web') then
    on_open_file = function(path, open_in_tab, document_id, version, fragment)
      if
        document_id ~= preview_id
        or not previewed_bufnr
        or not vim.api.nvim_buf_is_valid(previewed_bufnr)
        or version ~= vim.api.nvim_buf_get_changedtick(previewed_bufnr)
      then
        return
      end
      local ft = vim.filetype.match({ filename = path:lower() })
      if not vim.tbl_contains(config.get('filetype'), ft) then
        return
      end
      local nbufnr = vim.fn.bufadd(path)
      vim.fn.bufload(nbufnr)
      local explicit_open_in_tab = open_in_tab == true
      if open_in_tab == nil then
        open_in_tab = config.get('tab')
      end
      if open_in_tab then
        if explicit_open_in_tab then
          vim.cmd('tabnew')
          vim.api.nvim_set_current_buf(nbufnr)
        else
          local wins = vim.fn.win_findbuf(nbufnr)
          if #wins > 0 then
            vim.api.nvim_set_current_win(wins[1])
          else
            vim.cmd('tabnew')
            vim.api.nvim_set_current_buf(nbufnr)
          end
        end
      else
        vim.api.nvim_set_current_buf(nbufnr)
      end
      if not config.get('auto_load') then
        open(nbufnr)
      end
      if fragment ~= nil then
        app.navigate(preview_id, preview_key, preview_version, fragment)
      end
    end
    on_listdir = function(path)
      local entries = {}
      local names = vim.fn.readdir(path)
      for _, name in ipairs(names) do
        if not name:match('^%.') then
          local full = vim.fs.joinpath(path, name)
          local is_dir = vim.fn.isdirectory(full) == 1
          table.insert(entries, { name = name, path = full, isDir = is_dir })
        end
      end
      table.sort(entries, function(a, b)
        if a.isDir ~= b.isDir then
          return a.isDir
        end
        return a.name < b.name
      end)
      app.dirlist(path, entries)
    end
  end

  local function move_preview_cursor(target_line, document_id, version, focus)
    if not previewed_bufnr or not vim.api.nvim_buf_is_valid(previewed_bufnr) then
      return
    end
    if document_id ~= preview_id or version ~= vim.api.nvim_buf_get_changedtick(previewed_bufnr) then
      return
    end

    local winid = previewed_winid
    if not winid or not vim.api.nvim_win_is_valid(winid) or vim.api.nvim_win_get_buf(winid) ~= previewed_bufnr then
      winid = vim.fn.win_findbuf(previewed_bufnr)[1]
      if not winid then
        return
      end
      previewed_winid = winid
    end

    local last_line = vim.api.nvim_buf_line_count(previewed_bufnr)
    target_line = math.max(1, math.min(target_line, last_line))
    if focus then
      vim.api.nvim_set_current_win(winid)
    end
    vim.api.nvim_win_set_cursor(winid, { target_line, 0 })
    vim.api.nvim_win_call(winid, function()
      vim.cmd('normal! zz')
    end)
  end

  local function on_browser_scroll(target_line, document_id, version)
    if not config.get('sync_scroll_from_browser') then
      return
    end
    move_preview_cursor(target_line, document_id, version, false)
  end

  local function on_source(target_line, document_id, version)
    if not config.get('useful_web') then
      return
    end
    move_preview_cursor(target_line, document_id, version, true)
  end

  local function on_select_tab(tabpage)
    if not vim.api.nvim_tabpage_is_valid(tabpage) then
      return
    end

    local winid = vim.api.nvim_tabpage_get_win(tabpage)
    local selected_bufnr = vim.api.nvim_win_get_buf(winid)
    if not vim.tbl_contains(config.get('filetype'), vim.bo[selected_bufnr].filetype) then
      return
    end

    vim.api.nvim_set_current_tabpage(tabpage)
    if previewed_bufnr ~= selected_bufnr then
      open(selected_bufnr)
    else
      schedule_tabs()
    end
  end

  local function on_render(document_id, document_key, version)
    send_preview_content(document_id, document_key, version, true)
  end

  app.init(function()
    if show_throttled then
      show_throttled:clear()
      show_throttled = nil
    end
    augroup = nvim_del_augroup_by_id(augroup)
    last_tabs_signature = nil
    tabs_scheduled = false
    local was_restarting = restarting
    restarting = false
    if was_restarting then
      vim.schedule(function()
        open(previewed_bufnr)
      end)
    end
  end, on_open_file, on_listdir, on_browser_scroll, on_select_tab, on_source, on_render)
  app.document(preview_id, preview_key, preview_version, vim.api.nvim_buf_get_name(bufnr))
  send_tabs()
  app.base(vim.fn.fnamemodify(vim.uri_to_fname(vim.uri_from_bufnr(bufnr)), ':p:h'))
  if sent_versions[preview_key] == preview_version then
    app.restore(preview_id, preview_key, preview_version)
    send_preview_scroll()
  else
    send_preview_content(preview_id, preview_key, preview_version)
  end

  local document_id = preview_id
  local document_key = preview_key
  show_throttled = throttle(function()
    send_preview_content(document_id, document_key)
  end)

  local function show()
    local version = vim.api.nvim_buf_get_changedtick(bufnr)
    preview_version = version
    if sent_versions[document_key] ~= version then
      app.updating(document_id, document_key, version)
    end
    local len = vim.api.nvim_buf_get_offset(bufnr, vim.api.nvim_buf_line_count(bufnr))
    if len < 0 then
      len = #get_buf_content(bufnr)
    end

    if len > throttle_at then
      show_throttled:set_timeout(throttle_time or len / 200)
      return show_throttled()
    end

    show_throttled:clear()
    send_preview_content(document_id, document_key)
  end

  nvim_create_autocmd('BufWritePost', {
    group = augroup,
    buffer = bufnr,
    callback = show,
  })

  nvim_create_autocmd('BufFilePost', {
    group = augroup,
    buffer = bufnr,
    callback = function()
      sent_versions[document_key] = nil
      open(bufnr)
    end,
  })

  nvim_create_autocmd({ 'CursorMoved', 'CursorMovedI' }, {
    group = augroup,
    buffer = bufnr,
    callback = function()
      send_preview_scroll()
    end,
  })

  nvim_create_autocmd({ 'TabEnter', 'TabClosed' }, {
    group = augroup,
    callback = schedule_tabs,
  })

  if config.get('close_on_bdelete') then
    nvim_create_autocmd('BufDelete', {
      group = augroup,
      buffer = bufnr,
      callback = function()
        app.stop()
      end,
    })
  end

  if config.get('update_on_change') then
    nvim_create_autocmd({ 'TextChanged', 'TextChangedI', 'TextChangedP' }, {
      group = augroup,
      buffer = bufnr,
      callback = show,
    })
  end

  if config.get('auto_load') then
    nvim_create_autocmd('BufEnter', {
      group = augroup,
      callback = function(arg)
        if vim.tbl_contains(config.get('filetype'), vim.bo[arg.buf].filetype) then
          open(arg.buf)
        end
      end,
    })
  end
end

local function ensure_init(fn)
  return function(...)
    if not initialized then
      module.setup()
    end
    return fn(...)
  end
end

module.open = ensure_init(function()
  local bufnr = vim.api.nvim_get_current_buf()
  local filetype = config.get('filetype')

  if not vim.tbl_contains(filetype, vim.bo[bufnr].filetype) then
    ---@diagnostic disable-next-line: param-type-mismatch
    return vim.api.nvim_notify('Not a supported filetype: ' .. table.concat(filetype, ', '), vim.log.levels.WARN, {})
  end

  open(bufnr)
end)

module.close = ensure_init(function()
  app.stop()
end)

module.is_open = ensure_init(function()
  return not not augroup
end)

module.sync_tabs = ensure_init(function()
  send_tabs(true)
end)

module.set_useful_web = ensure_init(function(enabled)
  if restarting then
    return
  end
  if config.get('useful_web') == enabled then
    return
  end
  config.set('useful_web', enabled)
  if augroup then
    app.setup()
    restarting = true
    app.stop()
  end
end)

module.toggle_useful_web = ensure_init(function()
  module.set_useful_web(not config.get('useful_web'))
end)

function module.setup(cfg)
  config.setup(cfg)
  app.setup()
  throttle_at = config.get('throttle_at')
  throttle_time = tonumber(config.get('throttle_time'))
  initialized = true
end

return module
